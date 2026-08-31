"""Fetch a complete schema set starting from a single remote XSD URL.

Used by the auto-schema endpoint: an XML document names its schema through
``xsi:schemaLocation`` / ``xsi:noNamespaceSchemaLocation``, and that schema in
turn pulls in others via ``xs:include`` / ``xs:import``. This module walks those
references over the network and returns the same ``filename -> bytes`` map that
``load_xsd_from_files`` already consumes.

Two details make the result compile offline afterwards:

* Every document is keyed by ``host/path`` of the URL it was fetched from, so
  relative references between documents of the same host resolve identically
  once the set is materialised into a temp directory.
* ``schemaLocation`` values are rewritten to the matching relative path.
  ``build_xmlschema`` compiles with ``no_network=True``, so an absolute URL left
  in place would silently fail to resolve — lxml skips the import and then
  reports a confusing "does not resolve to a type definition" error instead.

Every fetch goes through ``security.fetch_url``, so the private-IP block,
DNS pinning, redirect re-verification and per-response size cap all apply.
"""

from __future__ import annotations

import logging
import posixpath
from collections import deque
from urllib.parse import urljoin, urlsplit

from lxml import etree

from app.config import settings
from app.parser.security import fetch_url as _default_fetch
from app.parser.security import make_parser
from app.parser.xsd_store import (
    _REF_TAGS,
    XsdError,
    _iter_schema_locations,
    _safe_relative_path,
)

logger = logging.getLogger(__name__)

XSD_NS = "http://www.w3.org/2001/XMLSchema"

# Upper bound on how many documents one auto-detected schema may pull in.
AUTO_SCHEMA_MAX_DOCS = 25


def is_schema_document(data: bytes) -> bool:
    """True when ``data`` parses as XML whose root is ``xs:schema``.

    Guards against a URL that answers with an HTML error/login page: without
    this the failure surfaces as an opaque XSD parse error.
    """
    try:
        root = etree.fromstring(data, make_parser())
    except etree.XMLSyntaxError:
        return False
    if not isinstance(root.tag, str):
        return False
    qname = etree.QName(root)
    return qname.localname == "schema" and qname.namespace == XSD_NS


def _url_key(url: str) -> str:
    """Map a URL to the relative path its document gets in the schema set.

    Keyed by ``host/path`` so two hosts serving ``/xsd/base.xsd`` do not
    collide, while same-host relative references still line up.
    """
    parts = urlsplit(url)
    return str(_safe_relative_path(f"{parts.netloc}{parts.path}", "schema.xsd"))


def _rewrite_locations(data: bytes, doc_key: str, url_to_key: dict[str, str], base_url: str) -> bytes:
    """Point every fetched ``schemaLocation`` in ``data`` at its local path.

    References we could not fetch are left untouched, so the compile error
    still names the original location.
    """
    try:
        root = etree.fromstring(data, make_parser())
    except etree.XMLSyntaxError:
        return data

    doc_dir = posixpath.dirname(doc_key) or "."
    changed = False
    for el in root.iter():
        if not isinstance(el.tag, str) or etree.QName(el).localname not in _REF_TAGS:
            continue
        loc = el.get("schemaLocation")
        if not loc:
            continue
        target = url_to_key.get(urljoin(base_url, loc))
        if target is None:
            continue
        relative = posixpath.relpath(target, doc_dir)
        if relative != loc:
            el.set("schemaLocation", relative)
            changed = True

    if not changed:
        return data
    return etree.tostring(root, encoding="UTF-8", xml_declaration=True)


def fetch_schema_set(url: str, *, fetcher=None) -> tuple[dict[str, bytes], str]:
    """Download the schema at ``url`` plus everything it references.

    Returns ``(files, main_filename)`` ready for ``load_xsd_from_files``.
    Raises :class:`XsdError` when the URL does not serve a schema or a cap is
    hit, and ``SecurityError`` (from ``fetch_url``) when a URL is not allowed.
    """
    fetch = fetcher or _default_fetch

    files: dict[str, bytes] = {}
    url_to_key: dict[str, str] = {}
    # Keyed by document, so locations can be rewritten once the whole set is known.
    bases: dict[str, str] = {}
    seen: set[str] = set()
    queue: deque[str] = deque([url])
    main_key: str | None = None
    total = 0

    while queue:
        current = queue.popleft()
        if current in seen:
            continue
        seen.add(current)
        is_main = main_key is None

        if len(files) >= AUTO_SCHEMA_MAX_DOCS:
            raise XsdError(
                f"the referenced schema pulls in more than {AUTO_SCHEMA_MAX_DOCS} documents; "
                "load it manually instead"
            )

        try:
            fetched = fetch(current)
        except Exception as exc:
            # Only the entry point has to be reachable. A dependency that 404s
            # may still be covered by BUNDLED_SCHEMAS, and if it is not, the
            # compile error names the location — far more useful than failing
            # the whole load here. (FundsXML is the live case: its relative
            # xmldsig import resolves against GitHub's signed asset URL.)
            if is_main:
                raise
            logger.info(
                "auto-schema dependency not fetched",
                extra={"ctx_url": current, "ctx_error": str(exc)},
            )
            continue
        data = fetched.content

        if is_main and not is_schema_document(data):
            raise XsdError(
                f"the schema URL referenced by this document did not return an XML Schema: {current}"
            )

        total += len(data)
        if total > settings.max_upload_bytes:
            raise XsdError(
                f"the referenced schema set exceeds the {settings.max_upload_mb} MB limit"
            )

        # Key by the *requested* URL — a redirect target is often an opaque
        # signed URL, and that path would end up as the displayed filename.
        # Relative references are still resolved against the final URL.
        key = _url_key(current)
        files[key] = data
        bases[key] = fetched.url
        url_to_key[current] = key
        url_to_key[fetched.url] = key
        if is_main:
            main_key = key

        for loc in _iter_schema_locations(data, include_remote=True):
            nxt = urljoin(fetched.url, loc)
            if urlsplit(nxt).scheme.lower() in ("http", "https") and nxt not in seen:
                queue.append(nxt)

    if main_key is None:  # unreachable: the queue always starts non-empty
        raise XsdError("no schema could be downloaded")

    rewritten = {
        key: _rewrite_locations(data, key, url_to_key, bases[key]) for key, data in files.items()
    }
    logger.info(
        "auto-schema fetched",
        extra={"ctx_url": url, "ctx_docs": len(rewritten), "ctx_bytes": total},
    )
    return rewritten, main_key
