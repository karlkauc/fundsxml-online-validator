"""FastAPI application entrypoint."""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app import __version__
from app.api.feedback import router as feedback_router
from app.api.releases import router as releases_router
from app.api.validate import router as validate_router
from app.api.xml import router as xml_router
from app.api.xsd import router as xsd_router
from app.config import settings
from app.logging_setup import configure_logging, new_request_id, request_id_var
from app.rate_limit import limiter
from app.usage.context import RequestUsage, UsageTracker, bind, emit, unbind
from app.usage.feedback import FeedbackStore
from app.usage.geoip import GeoIp
from app.usage.recorder import UsageRecorder

configure_logging(settings.log_level)
logger = logging.getLogger("app")


class BufferRequestBodyMiddleware:
    """Drain the entire request body before the app can respond.

    Why: when the app returns an error mid-upload (e.g. a parse error after
    reading the form), uvicorn closes the upstream TCP connection without
    consuming the rest of the body. A reverse proxy still streaming the body
    upstream then delivers 502 instead of the real 4xx. Buffering the body in
    the ASGI layer makes it always fully received before any handler runs.
    """

    def __init__(self, app, buffered_methods: tuple[str, ...] = ("POST", "PUT", "PATCH")) -> None:
        self.app = app
        self.buffered_methods = buffered_methods

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or scope.get("method") not in self.buffered_methods:
            await self.app(scope, receive, send)
            return

        chunks: list[bytes] = []
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] == "http.request":
                body = message.get("body")
                if body:
                    chunks.append(body)
                if not message.get("more_body", False):
                    break

        buffered = b"".join(chunks)
        sent = False

        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": buffered, "more_body": False}
            return {"type": "http.disconnect"}

        await self.app(scope, replay, send)


def build_usage_tracker() -> UsageTracker:
    """Usage statistics — inert unless USAGE_DB_URL is set (docs/USAGE_STATS.md)."""
    recorder = UsageRecorder(settings.usage_db_url, settings.usage_db_password)
    geoip = GeoIp(settings.geoip_db_path, settings.maxmind_license_key) if recorder.enabled else None
    if recorder.enabled and not settings.usage_hash_secret:
        logger.warning("USAGE_HASH_SECRET is empty; visitor hashes are only date-salted")
    return UsageTracker(recorder, geoip, settings.usage_hash_secret)


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    tracker = build_usage_tracker()
    application.state.usage = tracker
    await tracker.start()
    try:
        yield
    finally:
        await tracker.stop()


app = FastAPI(
    title="XML Online Viewer",
    version=__version__,
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

app.state.limiter = limiter
# Module level (not in lifespan): existing tests use TestClient(app) without a
# context manager, and the feedback store has no start/stop lifecycle anyway.
app.state.feedback = FeedbackStore(settings.feedback_db_url, settings.feedback_db_password)


@app.exception_handler(RateLimitExceeded)
async def _rate_limit_exceeded(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={"error": "rate_limit_exceeded", "detail": f"limit: {exc.detail}"},
        headers={"Retry-After": "60"},
    )


app.add_middleware(SlowAPIMiddleware)
app.add_middleware(BufferRequestBodyMiddleware)
# Cloud Run rejects non-streamed responses above 32 MiB ("Response size was too
# large"); the JSON tree of a ~12 MB XML upload already exceeded that. The limit
# applies to the bytes on the wire, so compressing the (highly repetitive) JSON
# keeps large documents deliverable. Responses carry no per-user secrets, so
# BREACH-style attacks on compressed bodies are not a concern here.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)  # 6: ~3x faster than 9, ~5% larger

# Same-origin deployment: the SPA is served from the same host as the API.
# Set CORS_ALLOW_ORIGINS only if a foreign frontend should call the API.
if settings.cors_allow_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_allow_origins),
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Accept"],
    )


# Security headers on every response. On Cloud Run there is no reverse proxy to
# add these, so the app must. The SPA shell sets a stricter CSP/X-Frame-Options
# of its own (see spa_fallback); setdefault preserves those more specific values
# while still covering API and static-asset responses.
@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    # The SPA shell relaxes this to "unsafe-none" so the XSD viewer can open
    # us in a new tab and hand a file over via postMessage (see spa_fallback).
    response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    return response


@app.middleware("http")
async def request_logging(request: Request, call_next):
    rid = new_request_id()
    token = request_id_var.set(rid)
    tracker: UsageTracker | None = getattr(request.app.state, "usage", None)
    usage: RequestUsage | None = (
        RequestUsage(
            tracker=tracker,
            ip=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
            referrer=request.headers.get("referer"),
        )
        if tracker is not None
        else None
    )
    usage_token = bind(usage)
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        logger.exception(
            "request failed",
            extra={"ctx_method": request.method, "ctx_path": request.url.path},
        )
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error", "request_id": rid},
        )
    finally:
        request_id_var.reset(token)
        unbind(usage_token)
    if usage is not None and usage.emitted:
        # Cloud Run throttles CPU after the response; give the writer a bounded
        # chance to finish while we still have it (see docs/USAGE_STATS.md).
        await usage.tracker.recorder.drain(timeout=settings.usage_drain_seconds)
    duration_ms = round((time.perf_counter() - start) * 1000, 2)
    logger.info(
        "request completed",
        extra={
            "ctx_method": request.method,
            "ctx_path": request.url.path,
            "ctx_status": response.status_code,
            "ctx_duration_ms": duration_ms,
        },
    )
    response.headers["X-Request-ID"] = rid
    return response


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


app.include_router(xml_router, prefix="/api")
app.include_router(xsd_router, prefix="/api")
app.include_router(validate_router, prefix="/api")
app.include_router(releases_router, prefix="/api")
app.include_router(feedback_router, prefix="/api")

# --- Static frontend ------------------------------------------------------
# Serves the built React SPA. In dev, the Vite dev-server runs separately and
# proxies /api; in production the Docker image copies the built assets to
# settings.static_dir and FastAPI serves them here.
# Client-side routes the SPA actually handles (see frontend/src/App.tsx).
# Everything else that is not a real file on disk is a 404: returning
# index.html with 200 for /wp-admin/install.php & co. keeps scanners coming
# back and pollutes the page_view statistics.
SPA_ROUTES = frozenset({"", "index.html", "fundsxml"})

_SPA_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "font-src 'self' data:; "
        "connect-src 'self'"
    ),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    # Keep window.opener alive: xsd-viewer.online opens this page
    # with ?from=xsd-viewer and posts the XML file to it.
    "Cross-Origin-Opener-Policy": "unsafe-none",
    "Referrer-Policy": "no-referrer",
}


def mount_spa(app: FastAPI, static_path: Path) -> None:
    """Serve the built React SPA from ``static_path`` (must contain index.html)."""
    app.mount("/assets", StaticFiles(directory=static_path / "assets"), name="assets")
    static_root = static_path.resolve()
    index_file = static_path / "index.html"

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str) -> Response:
        if full_path.startswith("api/"):
            return JSONResponse(status_code=404, content={"error": "not_found"})
        route = full_path.strip("/")
        if route not in SPA_ROUTES:
            candidate = (static_root / route).resolve()
            if static_root in candidate.parents and candidate.is_file():
                return FileResponse(candidate)
            return JSONResponse(status_code=404, content={"error": "not_found"})
        emit("page_view", path="/" + route, status_code=200)
        return Response(content=index_file.read_bytes(), media_type="text/html", headers=_SPA_HEADERS)


_static_path = Path(settings.static_dir)
if _static_path.is_dir() and (_static_path / "index.html").is_file():
    mount_spa(app, _static_path)
else:
    logger.info(
        "static assets not found; API-only mode",
        extra={"ctx_static_dir": str(_static_path)},
    )
