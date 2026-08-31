"""Auto-detecting the XSD a document points at, and fetching the schema set.

No test performs real network I/O: ``fetch_url`` is replaced by a fake serving
an in-memory URL -> bytes map, following the pattern in ``test_security.py``.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.parser import schema_fetch
from app.parser.schema_fetch import AUTO_SCHEMA_MAX_DOCS, fetch_schema_set
from app.parser.security import FetchedResource, SecurityError
from app.parser.xml_tree import parse_xml
from app.parser.xsd_store import XsdError, build_xmlschema, load_xsd_from_files

XSI = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'

PERSON_XSD = b"""<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="person">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="name" type="xs:string"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>"""


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _fake_fetcher(pages: dict[str, bytes], calls: list[str] | None = None):
    def fetch(url: str) -> FetchedResource:
        if calls is not None:
            calls.append(url)
        if url not in pages:
            raise AssertionError(f"unexpected fetch of {url!r}")
        return FetchedResource(url=url, content=pages[url], content_type="application/xml")

    return fetch


# ---------------------------------------------------------------------------
# Hint extraction (parse_xml)
# ---------------------------------------------------------------------------


def test_no_namespace_schema_location_is_an_absolute_hint() -> None:
    xml = f'<root {XSI} xsi:noNamespaceSchemaLocation="https://h/x.xsd"/>'.encode()
    hints = parse_xml(xml, "doc.xml").model.schema_hints
    assert len(hints) == 1
    assert hints[0].namespace is None
    assert hints[0].location == "https://h/x.xsd"
    assert hints[0].resolved_url == "https://h/x.xsd"


def test_schema_location_pairs_split_on_any_whitespace_root_namespace_first() -> None:
    # Newline- and tab-separated pairs are common in pretty-printed XML.
    xml = (
        f'<r:root xmlns:r="urn:root" {XSI} xsi:schemaLocation="urn:other\thttps://h/other.xsd\n'
        'urn:root https://h/root.xsd"/>'
    ).encode()
    hints = parse_xml(xml, "doc.xml").model.schema_hints
    assert [(h.namespace, h.location) for h in hints] == [
        ("urn:root", "https://h/root.xsd"),
        ("urn:other", "https://h/other.xsd"),
    ]


def test_odd_trailing_token_in_schema_location_is_ignored() -> None:
    xml = f'<root {XSI} xsi:schemaLocation="urn:a https://h/a.xsd urn:dangling"/>'.encode()
    hints = parse_xml(xml, "doc.xml").model.schema_hints
    assert [h.location for h in hints] == ["https://h/a.xsd"]


def test_relative_location_without_base_url_is_not_resolvable() -> None:
    xml = f'<root {XSI} xsi:noNamespaceSchemaLocation="schema/x.xsd"/>'.encode()
    hint = parse_xml(xml, "doc.xml").model.schema_hints[0]
    assert hint.location == "schema/x.xsd"
    assert hint.resolved_url is None


def test_relative_location_resolves_against_the_documents_url() -> None:
    xml = f'<root {XSI} xsi:noNamespaceSchemaLocation="schema/x.xsd"/>'.encode()
    model = parse_xml(xml, "doc.xml", base_url="https://h/a/doc.xml").model
    assert model.source_url == "https://h/a/doc.xml"
    assert model.schema_hints[0].resolved_url == "https://h/a/schema/x.xsd"


def test_non_http_scheme_is_not_resolvable() -> None:
    xml = f'<root {XSI} xsi:noNamespaceSchemaLocation="file:///etc/x.xsd"/>'.encode()
    assert parse_xml(xml, "doc.xml").model.schema_hints[0].resolved_url is None


def test_document_without_xsi_attributes_has_no_hints() -> None:
    assert parse_xml(b"<root/>", "doc.xml").model.schema_hints == []


# ---------------------------------------------------------------------------
# fetch_schema_set
# ---------------------------------------------------------------------------


def test_fetches_only_the_single_document_when_nothing_is_referenced() -> None:
    calls: list[str] = []
    files, main = fetch_schema_set(
        "https://h/person.xsd",
        fetcher=_fake_fetcher({"https://h/person.xsd": PERSON_XSD}, calls),
    )
    assert calls == ["https://h/person.xsd"]
    assert main == "h/person.xsd"
    assert set(files) == {"h/person.xsd"}


def test_follows_relative_includes_and_compiles() -> None:
    main_xsd = b"""<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:include schemaLocation="sub/base.xsd"/>
  <xs:element name="root" type="BaseType"/>
</xs:schema>"""
    base_xsd = b"""<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="BaseType"><xs:sequence/></xs:complexType>
</xs:schema>"""
    calls: list[str] = []
    files, main = fetch_schema_set(
        "https://h/x/main.xsd",
        fetcher=_fake_fetcher(
            {"https://h/x/main.xsd": main_xsd, "https://h/x/sub/base.xsd": base_xsd}, calls
        ),
    )
    assert calls == ["https://h/x/main.xsd", "https://h/x/sub/base.xsd"]
    assert set(files) == {"h/x/main.xsd", "h/x/sub/base.xsd"}
    build_xmlschema(load_xsd_from_files(files, main))


def test_absolute_cross_host_imports_are_rewritten_so_the_set_compiles_offline() -> None:
    # build_xmlschema compiles with no_network=True: an absolute URL left in
    # place would be silently skipped and the type would not resolve.
    main_xsd = b"""<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           xmlns:o="urn:other" elementFormDefault="qualified">
  <xs:import namespace="urn:other" schemaLocation="https://other.example/y/other.xsd"/>
  <xs:element name="root" type="o:T"/>
</xs:schema>"""
    other_xsd = b"""<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:other">
  <xs:complexType name="T"><xs:sequence/></xs:complexType>
</xs:schema>"""
    files, main = fetch_schema_set(
        "https://h/x/main.xsd",
        fetcher=_fake_fetcher(
            {"https://h/x/main.xsd": main_xsd, "https://other.example/y/other.xsd": other_xsd}
        ),
    )
    assert b"https://other.example" not in files["h/x/main.xsd"]
    assert b"../../other.example/y/other.xsd" in files["h/x/main.xsd"]
    build_xmlschema(load_xsd_from_files(files, main))


def test_a_reference_cycle_terminates() -> None:
    a = b"""<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:include schemaLocation="b.xsd"/>
</xs:schema>"""
    b = b"""<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:include schemaLocation="a.xsd"/>
</xs:schema>"""
    calls: list[str] = []
    files, _ = fetch_schema_set(
        "https://h/a.xsd",
        fetcher=_fake_fetcher({"https://h/a.xsd": a, "https://h/b.xsd": b}, calls),
    )
    assert calls == ["https://h/a.xsd", "https://h/b.xsd"]
    assert set(files) == {"h/a.xsd", "h/b.xsd"}


def test_an_unfetchable_dependency_does_not_fail_the_load() -> None:
    # The live FundsXML case: its relative xmldsig import resolves against
    # GitHub's signed asset URL and 404s, but BUNDLED_SCHEMAS covers it.
    main_xsd = b"""<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:include schemaLocation="missing.xsd"/>
  <xs:element name="root" type="xs:string"/>
</xs:schema>"""

    def fetch(url: str) -> FetchedResource:
        if url != "https://h/main.xsd":
            raise SecurityError(f"fetching {url!r} failed with HTTP 404")
        return FetchedResource(url=url, content=main_xsd, content_type="application/xml")

    files, main = fetch_schema_set("https://h/main.xsd", fetcher=fetch)
    assert set(files) == {"h/main.xsd"}
    assert main == "h/main.xsd"
    # The unresolved location is left untouched, so a later compile error names it.
    assert b'schemaLocation="missing.xsd"' in files["h/main.xsd"]


def test_an_unfetchable_entry_point_still_fails() -> None:
    def fetch(url: str) -> FetchedResource:
        raise SecurityError("host is not reachable")

    with pytest.raises(SecurityError):
        fetch_schema_set("https://h/main.xsd", fetcher=fetch)


def test_a_redirect_keeps_the_requested_url_as_the_display_name() -> None:
    # GitHub redirects release assets to an opaque signed URL; keying by that
    # would surface a UUID as the schema's filename.
    def fetch(url: str) -> FetchedResource:
        return FetchedResource(
            url="https://cdn.example/blob/9f2c-4511", content=PERSON_XSD, content_type=None
        )

    files, main = fetch_schema_set("https://h/releases/FundsXML.xsd", fetcher=fetch)
    assert main == "h/releases/FundsXML.xsd"
    assert set(files) == {"h/releases/FundsXML.xsd"}


def test_html_error_page_is_rejected_with_a_readable_message() -> None:
    with pytest.raises(XsdError, match="did not return an XML Schema"):
        fetch_schema_set(
            "https://h/login",
            fetcher=_fake_fetcher({"https://h/login": b"<html><body>Sign in</body></html>"}),
        )


def test_document_cap_is_enforced() -> None:
    total = AUTO_SCHEMA_MAX_DOCS + 5
    pages = {
        f"https://h/s{i}.xsd": (
            '<?xml version="1.0"?>'
            '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">'
            + (f'<xs:include schemaLocation="s{i + 1}.xsd"/>' if i + 1 < total else "")
            + "</xs:schema>"
        ).encode()
        for i in range(total)
    }
    with pytest.raises(XsdError, match="more than"):
        fetch_schema_set("https://h/s0.xsd", fetcher=_fake_fetcher(pages))


def test_total_size_cap_is_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import settings

    monkeypatch.setattr(settings, "max_upload_mb", 0)
    with pytest.raises(XsdError, match="exceeds"):
        fetch_schema_set(
            "https://h/person.xsd", fetcher=_fake_fetcher({"https://h/person.xsd": PERSON_XSD})
        )


# ---------------------------------------------------------------------------
# POST /api/xsd/auto
# ---------------------------------------------------------------------------


def _load_xml(client: TestClient, content: str) -> str:
    r = client.post("/api/xml/text", json={"content": content, "filename": "doc.xml"})
    assert r.status_code == 200, r.text
    return r.json()["xml_id"]


def test_auto_loads_the_referenced_schema_and_validates(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        schema_fetch, "_default_fetch", _fake_fetcher({"https://h/person.xsd": PERSON_XSD})
    )
    xml_id = _load_xml(
        client,
        f'<person {XSI} xsi:noNamespaceSchemaLocation="https://h/person.xsd">'
        "<name>Karl</name></person>",
    )

    r = client.post("/api/xsd/auto", json={"xml_id": xml_id})
    assert r.status_code == 200, r.text
    assert r.json()["main_filename"] == "h/person.xsd"

    v = client.post("/api/validate", json={"xml_id": xml_id, "xsd_id": r.json()["xsd_id"]})
    assert v.status_code == 200, v.text
    assert v.json()["is_valid"] is True


def test_auto_reports_validation_errors_against_the_detected_schema(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        schema_fetch, "_default_fetch", _fake_fetcher({"https://h/person.xsd": PERSON_XSD})
    )
    xml_id = _load_xml(
        client,
        f'<person {XSI} xsi:noNamespaceSchemaLocation="https://h/person.xsd"><wrong/></person>',
    )
    xsd_id = client.post("/api/xsd/auto", json={"xml_id": xml_id}).json()["xsd_id"]
    body = client.post("/api/validate", json={"xml_id": xml_id, "xsd_id": xsd_id}).json()
    assert body["is_valid"] is False
    assert body["errors"]


def test_auto_returns_404_when_the_document_references_nothing(client: TestClient) -> None:
    xml_id = _load_xml(client, "<person><name>Karl</name></person>")
    r = client.post("/api/xsd/auto", json={"xml_id": xml_id})
    assert r.status_code == 404
    assert "does not reference" in r.json()["detail"]


def test_auto_returns_404_for_a_relative_location_in_an_uploaded_document(
    client: TestClient,
) -> None:
    # Pasted/uploaded documents have no base URL, so "person.xsd" is on the
    # user's disk and can only be loaded manually.
    xml_id = _load_xml(client, f'<person {XSI} xsi:noNamespaceSchemaLocation="person.xsd"/>')
    assert client.post("/api/xsd/auto", json={"xml_id": xml_id}).status_code == 404


def test_auto_returns_404_for_an_unknown_xml_id(client: TestClient) -> None:
    r = client.post("/api/xsd/auto", json={"xml_id": "0" * 32})
    assert r.status_code == 404
    assert "expired" in r.json()["detail"]


def test_auto_returns_422_when_the_url_serves_something_that_is_not_a_schema(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        schema_fetch, "_default_fetch", _fake_fetcher({"https://h/x.xsd": b"<html>nope</html>"})
    )
    xml_id = _load_xml(client, f'<person {XSI} xsi:noNamespaceSchemaLocation="https://h/x.xsd"/>')
    r = client.post("/api/xsd/auto", json={"xml_id": xml_id})
    assert r.status_code == 422
    assert "did not return an XML Schema" in r.json()["detail"]
