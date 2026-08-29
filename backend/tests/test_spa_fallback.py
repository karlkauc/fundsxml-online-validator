"""SPA fallback: only known routes get index.html; scanner paths get 404 and no page_view."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.main as main_module
from app.main import mount_spa


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html>spa</html>")
    (tmp_path / "theme-init.js").write_text("// js")
    app = FastAPI()
    mount_spa(app, tmp_path)
    emitted: list[tuple[str, dict]] = []
    monkeypatch.setattr(main_module, "emit", lambda event_type, **f: emitted.append((event_type, f)))
    return TestClient(app), emitted


@pytest.mark.parametrize("path", ["/", "/index.html", "/fundsxml", "/fundsxml/"])
def test_known_routes_serve_index(client, path):
    c, _ = client
    r = c.get(path)
    assert r.status_code == 200
    assert "spa" in r.text
    assert "Content-Security-Policy" in r.headers


def test_static_file_served(client):
    c, _ = client
    r = c.get("/theme-init.js")
    assert r.status_code == 200
    assert r.text == "// js"


@pytest.mark.parametrize(
    "path",
    ["/wp-admin/install.php", "/.env", "/.git/config", "/blog/wp-includes/wlwmanifest.xml", "/foo"],
)
def test_unknown_paths_404(client, path):
    c, _ = client
    r = c.get(path)
    assert r.status_code == 404
    assert "spa" not in r.text


def test_page_view_only_for_known_routes(client):
    c, emitted = client
    c.get("/fundsxml")
    c.get("/wp-admin/install.php")
    c.get("/theme-init.js")
    assert emitted == [("page_view", {"path": "/fundsxml", "status_code": 200})]
