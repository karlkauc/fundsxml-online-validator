"""POST /api/feedback stores rows via FeedbackStore; logs when no DSN is set."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.rate_limit import limiter
from app.usage.context import UsageTracker
from app.usage.feedback import FEEDBACK_COLUMNS, FEEDBACK_INSERT_SQL, FeedbackRow, FeedbackStore
from app.usage.recorder import UsageRecorder


class FakeCursor:
    def __init__(self, conn: FakeConn) -> None:
        self.conn = conn

    async def __aenter__(self) -> FakeCursor:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def execute(self, sql: str, row: tuple) -> None:
        if self.conn.fail:
            raise RuntimeError("db down")
        self.conn.rows.append((sql, row))


class FakeConn:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.rows: list[tuple] = []
        self.committed = 0
        self.closed = False

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    async def commit(self) -> None:
        self.committed += 1

    async def close(self) -> None:
        self.closed = True


def make_store(fail: bool = False) -> tuple[FeedbackStore, FakeConn]:
    conn = FakeConn(fail=fail)

    async def connect(dsn: str, **kwargs):  # noqa: ANN202
        assert kwargs["password"] == "pw"
        return conn

    return FeedbackStore("postgresql://fake", "pw\n", connect=connect), conn


@pytest.fixture
def client() -> Iterator[TestClient]:
    limiter.reset()  # 5/minute per IP would trip across this module's tests
    original_store = app.state.feedback
    app.state.usage = UsageTracker(UsageRecorder("postgresql://fake"), geoip=None, hash_secret="s")
    try:
        yield TestClient(app, headers={"user-agent": "pytest-browser"})
    finally:
        del app.state.usage
        app.state.feedback = original_store


def test_insert_sql_lists_columns_explicitly() -> None:
    assert FEEDBACK_COLUMNS == (
        "message", "email", "page", "xml_name", "xsd_name", "error_detail",
        "visitor_hash", "country_code", "user_agent", "device", "app_version",
    )  # fmt: skip
    assert FEEDBACK_INSERT_SQL.startswith("INSERT INTO feedback (message, email, page, xml_name, xsd_name")
    assert FEEDBACK_INSERT_SQL.count("%s") == len(FEEDBACK_COLUMNS)


def test_store_inserts_and_closes() -> None:
    store, conn = make_store()
    asyncio.run(store.save(FeedbackRow(message="hi", xml_name="a.xml")))
    ((sql, row),) = conn.rows
    assert sql == FEEDBACK_INSERT_SQL and row[0] == "hi" and row[3] == "a.xml"
    assert conn.committed == 1 and conn.closed


def test_submit_stores_row_with_visitor_and_device(client: TestClient) -> None:
    store, conn = make_store()
    app.state.feedback = store
    r = client.post(
        "/api/feedback",
        json={
            "message": "  Tree view is great  ",
            "email": "a@b.co",
            "page": "/",
            "xml_name": "doc.xml",
            "xsd_name": "s.xsd",
            "error_detail": "x",
        },
    )
    assert r.status_code == 204
    ((_, row),) = conn.rows
    assert row[:6] == ("Tree view is great", "a@b.co", "/", "doc.xml", "s.xsd", "x")
    visitor, country, ua, device, version = row[6:]
    assert visitor and len(visitor) == 32 and "testclient" not in visitor
    assert country is None and ua == "pytest-browser" and device == "desktop" and version


def test_submit_without_tracker_has_no_visitor_hash(client: TestClient) -> None:
    del app.state.usage
    try:
        store, conn = make_store()
        app.state.feedback = store
        assert client.post("/api/feedback", json={"message": "hi"}).status_code == 204
        ((_, row),) = conn.rows
        assert row[6] is None and row[9] == "desktop"
    finally:
        app.state.usage = UsageTracker(UsageRecorder(""), geoip=None, hash_secret="")


def test_honeypot_is_dropped_silently(client: TestClient) -> None:
    store, conn = make_store()
    app.state.feedback = store
    r = client.post("/api/feedback", json={"message": "spam", "website": "http://x"})
    assert r.status_code == 204 and conn.rows == []


def test_not_configured_logs_warning(client: TestClient, caplog) -> None:
    app.state.feedback = FeedbackStore("")
    with caplog.at_level("WARNING", logger="app.api.feedback"):
        r = client.post("/api/feedback", json={"message": "hi", "xml_name": "d.xml"})
    assert r.status_code == 204
    assert any("user feedback" in rec.getMessage() for rec in caplog.records)


def test_db_failure_is_503(client: TestClient) -> None:
    store, _ = make_store(fail=True)
    app.state.feedback = store
    r = client.post("/api/feedback", json={"message": "hi"})
    assert r.status_code == 503 and "try again" in r.json()["detail"]


@pytest.mark.parametrize(
    "body",
    [{"message": ""}, {"message": "   "}, {"message": "x" * 4001}, {"message": "ok", "email": "nope"}],
)
def test_validation(client: TestClient, body: dict) -> None:
    app.state.feedback, _ = make_store()
    assert client.post("/api/feedback", json=body).status_code == 422
