"""Shared helpers for the API routers."""

from __future__ import annotations

import time

from fastapi import HTTPException, UploadFile

from app.config import settings
from app.usage.context import emit
from app.usage.events import schema_display_name


def _ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def reject(event_type: str, source: str | None, status_code: int, detail: str, **fields) -> HTTPException:
    """Record a rejected request (size limit, SSRF guard, expired cache) and build the HTTPException.

    Returns the exception instead of raising so call sites read ``raise reject(...)``
    and never emit twice.
    """
    emit(event_type, source=source, status="rejected", status_code=status_code, error_detail=detail, **fields)
    return HTTPException(status_code=status_code, detail=detail)


async def read_upload(upload: UploadFile, *, event_type: str, source: str = "upload") -> bytes:
    """Read an upload into memory, enforcing the configured size cap."""
    max_bytes = settings.max_upload_bytes
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(64 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise reject(
                event_type,
                source,
                413,
                f"upload exceeds {settings.max_upload_mb} MB limit",
                schema_name=schema_display_name(source, upload.filename),
            )
        chunks.append(chunk)
    return b"".join(chunks)


def reject_oversized_text(data: bytes, *, event_type: str, filename: str | None = None) -> None:
    if len(data) > settings.max_upload_bytes:
        raise reject(
            event_type,
            "text",
            413,
            f"content exceeds {settings.max_upload_mb} MB limit",
            schema_name=schema_display_name("text", filename),
        )
