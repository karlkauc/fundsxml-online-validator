"""End-to-end: events reach the recorder through middleware + routers."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from test_api import INVALID_XML, VALID_XML, XSD

from app.main import app
from app.usage.context import UsageTracker
from app.usage.events import UsageEvent
from app.usage.recorder import UsageRecorder


class ListRecorder(UsageRecorder):
    def __init__(self) -> None:
        super().__init__("postgresql://fake")
        self.events: list[UsageEvent] = []
        self.drains = 0

    def record(self, event: UsageEvent) -> bool:
        self.events.append(event)
        return True

    async def drain(self, timeout: float = 2.0) -> bool:
        self.drains += 1
        return True


@pytest.fixture
def recorder() -> Iterator[ListRecorder]:
    rec = ListRecorder()
    app.state.usage = UsageTracker(rec, geoip=None, hash_secret="test")
    try:
        yield rec
    finally:
        del app.state.usage


@pytest.fixture
def client() -> TestClient:
    return TestClient(app, headers={"user-agent": "pytest-browser", "referer": "https://ref.example/p?x=1"})


def test_xml_text_ok(client: TestClient, recorder: ListRecorder) -> None:
    r = client.post("/api/xml/text", json={"content": VALID_XML, "filename": "dir/v.xml"})
    assert r.status_code == 200
    (ev,) = recorder.events
    assert (ev.event_type, ev.source, ev.status, ev.status_code) == ("xml_load", "text", "ok", 200)
    assert ev.schema_name == "v.xml"
    assert ev.element_count == r.json()["node_count"] == 3
    assert ev.input_bytes == len(VALID_XML.encode()) and ev.file_count == 1
    assert ev.duration_ms is not None
    assert ev.visitor_hash and ev.user_agent == "pytest-browser" and ev.device == "desktop"
    assert ev.referrer == "https://ref.example/p"
    assert recorder.drains == 1


def test_xml_upload_ok(client: TestClient, recorder: ListRecorder) -> None:
    r = client.post("/api/xml/upload", files={"file": ("a/b/doc.xml", VALID_XML.encode(), "application/xml")})
    assert r.status_code == 200
    (ev,) = recorder.events
    assert ev.source == "upload" and ev.status == "ok" and ev.schema_name == "doc.xml"


def test_xml_parse_error(client: TestClient, recorder: ListRecorder) -> None:
    r = client.post("/api/xml/text", json={"content": "<a><b></a>", "filename": "x.xml"})
    assert r.status_code == 400
    (ev,) = recorder.events
    assert ev.event_type == "xml_load" and ev.status == "parse_error" and ev.status_code == 400
    assert ev.error_detail and "well-formed" in ev.error_detail
    assert ev.element_count is None


def test_xsd_text_ok(client: TestClient, recorder: ListRecorder) -> None:
    r = client.post("/api/xsd/text", json={"content": XSD, "filename": "person.xsd"})
    assert r.status_code == 200
    (ev,) = recorder.events
    assert (ev.event_type, ev.source, ev.status) == ("xsd_load", "text", "ok")
    assert ev.schema_name == "person.xsd" and ev.file_count == 1
    assert ev.input_bytes == len(XSD.encode())


def test_xsd_invalid_is_parse_error_422(client: TestClient, recorder: ListRecorder) -> None:
    r = client.post("/api/xsd/text", json={"content": "<nope/>", "filename": "x.xsd"})
    assert r.status_code == 422
    (ev,) = recorder.events
    assert ev.event_type == "xsd_load" and ev.status == "parse_error" and ev.status_code == 422
    assert ev.error_detail


def test_full_flow_validate_and_export(client: TestClient, recorder: ListRecorder) -> None:
    xsd_id = client.post("/api/xsd/text", json={"content": XSD, "filename": "person.xsd"}).json()["xsd_id"]
    xml_id = client.post("/api/xml/text", json={"content": INVALID_XML, "filename": "i.xml"}).json()["xml_id"]
    r = client.post("/api/validate", json={"xml_id": xml_id, "xsd_id": xsd_id})
    assert r.status_code == 200
    vid = r.json()["validation_id"]
    assert client.get(f"/api/validate/{vid}/excel").status_code == 200
    assert client.get("/api/validate/nope/excel").status_code == 404

    kinds = [(e.event_type, e.source, e.status) for e in recorder.events]
    assert kinds == [
        ("xsd_load", "text", "ok"),
        ("xml_load", "text", "ok"),
        ("validate", None, "invalid"),
        ("export", "excel", "ok"),
        ("export", "excel", "rejected"),
    ]
    validate_ev, export_ev = recorder.events[2], recorder.events[3]
    assert validate_ev.error_count == 2 and validate_ev.duration_ms is not None
    assert validate_ev.schema_name == "person.xsd" and validate_ev.input_bytes
    assert export_ev.error_count == 2 and export_ev.schema_name == "person.xsd"
    assert recorder.events[4].status_code == 404


def test_valid_document_status_ok(client: TestClient, recorder: ListRecorder) -> None:
    xsd_id = client.post("/api/xsd/text", json={"content": XSD}).json()["xsd_id"]
    xml_id = client.post("/api/xml/text", json={"content": VALID_XML}).json()["xml_id"]
    client.post("/api/validate", json={"xml_id": xml_id, "xsd_id": xsd_id})
    ev = recorder.events[-1]
    assert ev.event_type == "validate" and ev.status == "ok" and ev.error_count == 0


def test_xml_url_rejected(client: TestClient, recorder: ListRecorder) -> None:
    r = client.post("/api/xml/url", json={"url": "http://127.0.0.1/x.xml?s=1"})
    assert r.status_code == 400
    (ev,) = recorder.events
    assert ev.event_type == "xml_load" and ev.status == "rejected" and ev.source == "url"
    assert ev.schema_name == "http://127.0.0.1/x.xml"


def test_xsd_url_rejected(client: TestClient, recorder: ListRecorder) -> None:
    r = client.post("/api/xsd/url", json={"url": "http://10.0.0.1/x.xsd?s=1"})
    assert r.status_code == 400
    (ev,) = recorder.events
    assert ev.event_type == "xsd_load" and ev.status == "rejected" and ev.schema_name == "http://10.0.0.1/x.xsd"


def test_validate_unknown_ids_rejected(client: TestClient, recorder: ListRecorder) -> None:
    r = client.post("/api/validate", json={"xml_id": "deadbeef", "xsd_id": "deadbeef"})
    assert r.status_code == 404
    (ev,) = recorder.events
    assert ev.event_type == "validate" and ev.status == "rejected" and ev.status_code == 404


def test_health_emits_nothing(client: TestClient, recorder: ListRecorder) -> None:
    assert client.get("/api/health").status_code == 200
    assert recorder.events == [] and recorder.drains == 0


def test_no_tracker_installed_is_fine() -> None:
    assert not hasattr(app.state, "usage")
    c = TestClient(app)
    assert c.post("/api/xml/text", json={"content": VALID_XML}).status_code == 200
    assert c.post("/api/xml/text", json={"content": "<a>"}).status_code == 400
    assert c.post("/api/validate", json={"xml_id": "x", "xsd_id": "y"}).status_code == 404


def test_lifespan_with_disabled_settings() -> None:
    with TestClient(app) as c:
        assert c.app.state.usage.enabled is False
        assert c.get("/api/health").status_code == 200
