"""Accept, validate and compile XSD schemas (single file or multi-file ZIP).

The cache holds each schema's source files keyed by relative path, so a
multi-file schema (include/import/redefine) can be re-materialised into a temp
directory at validation time, preserving the relative paths that
``schemaLocation`` references rely on.
"""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from lxml import etree

from app.config import settings
from app.parser.security import _reject_known_bombs, make_parser


class XsdError(ValueError):
    """The submitted schema cannot be used: missing main file, unsafe path,
    or it does not compile as an XSD. Surfaced as HTTP 400/422 by the API."""


@dataclass
class StoredXsd:
    """In-memory cache entry for a compiled-and-verified schema."""

    xsd_id: str
    main_filename: str
    # Relative POSIX path -> raw file bytes.
    files: dict[str, bytes]


# ---------------------------------------------------------------------------
# Path safety (shared shape with the online_viewer materialiser)
# ---------------------------------------------------------------------------


def _safe_relative_path(filename: str, fallback: str) -> PurePosixPath:
    """Map a filename to a temp-dir-relative path, stripping traversal or
    absolute components. Falls back to ``fallback`` if nothing usable remains."""
    raw = filename.replace("\\", "/")
    if "://" in raw:
        raw = raw.split("://", 1)[1]
        raw = raw.split("/", 1)[1] if "/" in raw else ""
    parts = [
        seg
        for seg in PurePosixPath(raw).parts
        if seg not in ("", ".", "..", "/") and "\x00" not in seg
    ]
    if not parts:
        return PurePosixPath(fallback)
    return PurePosixPath(*parts)


# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------


_REF_TAGS = {"include", "import", "redefine", "override"}

# Well-known schemas bundled with the app so multi-file schemas that reference
# them (e.g. FundsXML importing xmldsig-core-schema.xsd) compile even when the
# upload/release doesn't ship them. Keyed by bare filename.
_RES_DIR = Path(__file__).parent / "resources"
BUNDLED_SCHEMAS: dict[str, bytes] = (
    {p.name: p.read_bytes() for p in _RES_DIR.glob("*.xsd")} if _RES_DIR.is_dir() else {}
)


def _iter_schema_locations(data: bytes, *, include_remote: bool = False) -> list[str]:
    """Return all ``schemaLocation`` values of include/import/redefine/override
    in a single schema document (empty on parse failure).

    Absolute-URL locations are skipped by default: the local materialiser
    cannot resolve them (``no_network=True``). ``include_remote=True`` is used
    by the auto-schema fetcher, which resolves them over the network itself.
    """
    try:
        root = etree.fromstring(data, make_parser())
    except etree.XMLSyntaxError:
        return []
    locs: list[str] = []
    for el in root.iter():
        if not isinstance(el.tag, str) or etree.QName(el).localname not in _REF_TAGS:
            continue
        loc = el.get("schemaLocation")
        if loc and (include_remote or "://" not in loc):
            locs.append(loc)
    return locs


def _inject_bundled_dependencies(files: dict[str, bytes]) -> None:
    """Add bundled copies of referenced-but-missing well-known schemas in-place,
    so the schema compiles offline. Iterates to a fixpoint in case a bundled
    schema itself references another bundled one."""
    if not BUNDLED_SCHEMAS:
        return
    while True:
        present = {PurePosixPath(k).name for k in files}
        added = False
        for name, data in list(files.items()):
            if not name.lower().endswith(".xsd"):
                continue
            base = PurePosixPath(name).parent
            for loc in _iter_schema_locations(data):
                bn = PurePosixPath(loc).name
                if bn in present or bn not in BUNDLED_SCHEMAS:
                    continue
                resolved = str(_safe_relative_path(str(base / loc), loc))
                files[resolved] = BUNDLED_SCHEMAS[bn]
                present.add(bn)
                added = True
        if not added:
            return


def _referenced_paths(files: dict[str, bytes]) -> set[str]:
    """Collect the set of file paths referenced via ``schemaLocation`` across
    all schemas (xs:include/import/redefine/override), normalised to the same
    relative-path scheme as the ZIP entries. Used to find the root schema:
    the one no other schema points at."""
    referenced: set[str] = set()
    for name, data in files.items():
        if not name.lower().endswith(".xsd"):
            continue
        base = PurePosixPath(name).parent
        for loc in _iter_schema_locations(data):
            # Resolve relative to the referencing file's directory, then
            # normalise the same way ZIP entries are keyed.
            referenced.add(str(_safe_relative_path(str(base / loc), loc)))
            referenced.add(PurePosixPath(loc).name)  # also match by bare name
    return referenced


def _detect_root_xsd(files: dict[str, bytes], xsd_names: list[str]) -> str | None:
    """Return the single XSD that no other schema references, or None if the
    root is ambiguous (zero or several un-referenced schemas)."""
    referenced = _referenced_paths(files)
    roots = [n for n in xsd_names if n not in referenced and PurePosixPath(n).name not in referenced]
    return roots[0] if len(roots) == 1 else None


def _files_from_zip(zip_bytes: bytes, main_filename: str | None) -> tuple[dict[str, bytes], str]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as exc:
        raise XsdError(f"not a valid ZIP archive: {exc}") from exc

    entries = [info for info in archive.infolist() if not info.is_dir()]
    if len(entries) > settings.max_zip_entries:
        raise XsdError(
            f"ZIP has too many entries ({len(entries)} > {settings.max_zip_entries})"
        )

    files: dict[str, bytes] = {}
    total = 0
    for info in entries:
        # Reject symlink entries (unix mode S_IFLNK in the high 16 bits of
        # external_attr) — they could point outside the materialisation dir.
        if (info.external_attr >> 16) & 0o170000 == 0o120000:
            raise XsdError(f"symlinks are not permitted in archives: {info.filename!r}")
        # Zip-bomb guards, checked against the declared uncompressed size before
        # decompressing the entry.
        total += info.file_size
        if total > settings.max_zip_uncompressed_bytes:
            raise XsdError(
                f"ZIP uncompressed size exceeds {settings.max_zip_uncompressed_mb} MB cap"
            )
        if info.compress_size > 0 and info.file_size / info.compress_size > settings.max_zip_ratio:
            raise XsdError(
                f"ZIP entry {info.filename!r} has a suspicious compression ratio"
            )
        rel = str(_safe_relative_path(info.filename, info.filename))
        data = archive.read(info)
        _reject_known_bombs(data)
        files[rel] = data

    xsd_names = [name for name in files if name.lower().endswith(".xsd")]
    if not files:
        raise XsdError("ZIP archive is empty")

    if main_filename:
        wanted = str(_safe_relative_path(main_filename, main_filename))
        main = next((n for n in files if n == wanted or n.endswith("/" + wanted)), None)
        if main is None:
            raise XsdError(f"main file {main_filename!r} not found in archive")
    elif len(xsd_names) == 1:
        main = xsd_names[0]
    elif (detected := _detect_root_xsd(files, xsd_names)) is not None:
        main = detected
    else:
        raise XsdError(
            "could not determine the main schema; specify main_filename "
            f"(candidates: {', '.join(sorted(xsd_names)) or 'none'})"
        )
    return files, main


def build_xmlschema(stored: StoredXsd) -> etree.XMLSchema:
    """Materialise ``stored`` into a temp dir and compile its main file.

    Raises :class:`XsdError` if the schema does not compile.
    """
    from tempfile import TemporaryDirectory

    with TemporaryDirectory(prefix="xsd-") as tmp:
        tmp_root = Path(tmp).resolve()
        main_on_disk: Path | None = None

        for rel, data in stored.files.items():
            target = (tmp_root / rel).resolve()
            if not target.is_relative_to(tmp_root):
                raise XsdError(f"refusing unsafe schema filename: {rel!r}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            if rel == stored.main_filename:
                main_on_disk = target

        if main_on_disk is None:
            raise XsdError("schema main file is unavailable; cannot validate")

        try:
            xsd_tree = etree.parse(str(main_on_disk), make_parser())
            return etree.XMLSchema(xsd_tree)
        except etree.XMLSchemaParseError as exc:
            raise XsdError(f"not a valid XSD schema: {_scrub(exc, tmp_root)}") from exc
        except etree.XMLSyntaxError as exc:
            raise XsdError(f"schema could not be parsed: {_scrub(exc, tmp_root)}") from exc


def _scrub(exc: Exception, tmp_root: Path) -> str:
    """Strip the internal temp-dir path from an lxml error message so it is not
    leaked to clients (only the relative schema filename remains)."""
    return str(exc).replace(str(tmp_root) + "/", "").replace(str(tmp_root), "")


def load_xsd(
    *,
    zip_bytes: bytes | None,
    main_filename: str | None,
    main_bytes: bytes | None,
) -> StoredXsd:
    """Build a :class:`StoredXsd` from either a ZIP or a single schema file,
    verifying it compiles. Raises :class:`XsdError` on any failure."""
    if zip_bytes is not None:
        files, main = _files_from_zip(zip_bytes, main_filename)
    else:
        if main_bytes is None:
            raise XsdError("no schema content provided")
        _reject_known_bombs(main_bytes)
        name = str(_safe_relative_path(main_filename or "schema.xsd", "schema.xsd"))
        files, main = {name: main_bytes}, name

    _inject_bundled_dependencies(files)
    stored = StoredXsd(xsd_id="", main_filename=main, files=files)
    # Compile once now to fail fast on an invalid schema.
    build_xmlschema(stored)
    return stored


def load_xsd_from_files(files: dict[str, bytes], main_filename: str) -> StoredXsd:
    """Build a :class:`StoredXsd` from an in-memory ``filename -> bytes`` map
    (e.g. release assets pre-fetched from GitHub), verifying it compiles.

    Keys are normalised to the same relative-path scheme as ZIP entries, so
    filename-based ``schemaLocation`` imports resolve. Raises :class:`XsdError`
    if the main file is missing or the schema does not compile."""
    normalised: dict[str, bytes] = {}
    for name, data in files.items():
        _reject_known_bombs(data)
        normalised[str(_safe_relative_path(name, name))] = data
    main = str(_safe_relative_path(main_filename, main_filename))
    if main not in normalised:
        raise XsdError(f"main file {main_filename!r} not found in release assets")

    _inject_bundled_dependencies(normalised)
    stored = StoredXsd(xsd_id="", main_filename=main, files=normalised)
    build_xmlschema(stored)
    return stored
