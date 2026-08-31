"""XSD schema upload endpoints."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from app.api._common import _ms, read_upload, reject, reject_oversized_text
from app.cache import xml_cache, xsd_cache
from app.parser.schema_fetch import fetch_schema_set
from app.parser.security import SecurityError, fetch_url
from app.parser.xsd_store import StoredXsd, XsdError, load_xsd, load_xsd_from_files
from app.rate_limit import WRITE_LIMIT, limiter
from app.usage.context import emit
from app.usage.events import schema_display_name

logger = logging.getLogger(__name__)

router = APIRouter(tags=["xsd"])


class TextPayload(BaseModel):
    filename: str = Field(default="schema.xsd")
    content: str = Field(..., description="Raw XSD content")


class UrlPayload(BaseModel):
    url: str = Field(..., description="Absolute http(s) URL of the XSD")


class XsdInfo(BaseModel):
    xsd_id: str
    main_filename: str
    filenames: list[str]


def _finalize(stored: StoredXsd) -> XsdInfo:
    digest = hashlib.sha256()
    for name in sorted(stored.files):
        digest.update(name.encode("utf-8"))
        digest.update(stored.files[name])
    xsd_id = digest.hexdigest()[:32]
    stored.xsd_id = xsd_id
    xsd_cache.put(xsd_id, stored)
    logger.info(
        "xsd loaded",
        extra={"ctx_xsd_id": xsd_id, "ctx_files": len(stored.files)},
    )
    return XsdInfo(
        xsd_id=xsd_id,
        main_filename=stored.main_filename,
        filenames=sorted(stored.files),
    )


def ingest_xsd(
    *, source: str, schema_name: str | None, input_bytes: int, loader: Callable[[], StoredXsd]
) -> XsdInfo:
    """Run a loader callable, cache the result and emit one ``xsd_load`` usage event.

    Shared by the upload/text/url routes here and the FundsXML release loader
    (``api/releases.py``) so every XSD load is recorded the same way.
    """
    started = time.perf_counter()
    name = schema_display_name(source, schema_name)
    try:
        stored = loader()
    except (XsdError, SecurityError) as exc:
        status_code = 422 if isinstance(exc, XsdError) else 400
        emit(
            "xsd_load",
            source=source,
            schema_name=name,
            input_bytes=input_bytes,
            duration_ms=_ms(started),
            status="parse_error",
            status_code=status_code,
            error_detail=str(exc),
        )
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc
    info = _finalize(stored)
    emit(
        "xsd_load",
        source=source,
        schema_name=name,
        input_bytes=input_bytes,
        file_count=len(stored.files),
        duration_ms=_ms(started),
        status="ok",
        status_code=200,
    )
    return info


def _load(
    *,
    source: str,
    schema_name: str | None,
    zip_bytes: bytes | None,
    main_filename: str | None,
    main_bytes: bytes | None,
) -> XsdInfo:
    return ingest_xsd(
        source=source,
        schema_name=schema_name,
        input_bytes=len(zip_bytes if zip_bytes is not None else (main_bytes or b"")),
        loader=lambda: load_xsd(zip_bytes=zip_bytes, main_filename=main_filename, main_bytes=main_bytes),
    )


@router.post("/xsd/upload", response_model=XsdInfo)
@limiter.limit(WRITE_LIMIT)
async def upload_xsd(
    request: Request,
    file: UploadFile,
    main_filename: Annotated[str | None, Form()] = None,
) -> XsdInfo:
    content = await read_upload(file, event_type="xsd_load")
    name = file.filename or "schema.xsd"
    is_zip = name.lower().endswith(".zip") or (file.content_type or "").endswith("zip")
    if is_zip:
        return _load(
            source="upload",
            schema_name=main_filename or name,
            zip_bytes=content,
            main_filename=main_filename,
            main_bytes=None,
        )
    return _load(source="upload", schema_name=name, zip_bytes=None, main_filename=name, main_bytes=content)


@router.post("/xsd/text", response_model=XsdInfo)
@limiter.limit(WRITE_LIMIT)
async def upload_xsd_text(request: Request, payload: TextPayload) -> XsdInfo:
    data = payload.content.encode("utf-8")
    reject_oversized_text(data, event_type="xsd_load", filename=payload.filename)
    return _load(
        source="text",
        schema_name=payload.filename,
        zip_bytes=None,
        main_filename=payload.filename,
        main_bytes=data,
    )


@router.post("/xsd/url", response_model=XsdInfo)
@limiter.limit(WRITE_LIMIT)
async def upload_xsd_url(request: Request, payload: UrlPayload) -> XsdInfo:
    try:
        fetched = fetch_url(payload.url)
    except SecurityError as exc:
        raise reject(
            "xsd_load", "url", 400, str(exc), schema_name=schema_display_name("url", payload.url)
        ) from exc
    return _load(
        source="url",
        schema_name=fetched.url,
        zip_bytes=None,
        main_filename=fetched.url,
        main_bytes=fetched.content,
    )


class AutoPayload(BaseModel):
    xml_id: str = Field(..., description="Id of an already-loaded XML document")


@router.post("/xsd/auto", response_model=XsdInfo)
@limiter.limit(WRITE_LIMIT)
async def auto_load_xsd(request: Request, payload: AutoPayload) -> XsdInfo:
    """Load the schema the XML document points at, plus everything it imports.

    Mirrors what a desktop XML editor does: read ``xsi:schemaLocation`` /
    ``xsi:noNamespaceSchemaLocation`` off the root element and fetch it. Only
    hints that resolved to an http(s) URL are usable — a relative location in an
    uploaded file refers to the user's own disk and must be loaded manually.
    """
    stored = xml_cache.get(payload.xml_id)
    if stored is None:
        raise reject("xsd_load", "auto", 404, "XML not found or expired")

    url = next((h.resolved_url for h in stored.model.schema_hints if h.resolved_url), None)
    if url is None:
        raise reject(
            "xsd_load",
            "auto",
            404,
            "this document does not reference a downloadable schema",
            schema_name=schema_display_name("auto", stored.model.filename),
        )

    try:
        files, main = await asyncio.to_thread(fetch_schema_set, url)
    except SecurityError as exc:
        raise reject(
            "xsd_load", "auto", 400, str(exc), schema_name=schema_display_name("auto", url)
        ) from exc
    except XsdError as exc:
        raise reject(
            "xsd_load", "auto", 422, str(exc), schema_name=schema_display_name("auto", url)
        ) from exc

    return ingest_xsd(
        source="auto",
        schema_name=url,
        input_bytes=sum(len(data) for data in files.values()),
        loader=lambda: load_xsd_from_files(files, main),
    )
