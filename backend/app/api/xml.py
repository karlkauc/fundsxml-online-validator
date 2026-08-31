"""XML document upload / retrieval endpoints."""

from __future__ import annotations

import hashlib
import logging
import time

from fastapi import APIRouter, HTTPException, Request, UploadFile
from lxml import etree
from pydantic import BaseModel, Field

from app.api._common import _ms, read_upload, reject, reject_oversized_text
from app.cache import xml_cache
from app.parser.security import SecurityError, fetch_url
from app.parser.xml_tree import StoredXml, XmlDocModel, parse_xml
from app.rate_limit import READ_LIMIT, WRITE_LIMIT, limiter
from app.usage.context import emit
from app.usage.events import schema_display_name

logger = logging.getLogger(__name__)

router = APIRouter(tags=["xml"])


class TextPayload(BaseModel):
    filename: str = Field(default="document.xml")
    content: str = Field(..., description="Raw XML content")


class UrlPayload(BaseModel):
    url: str = Field(..., description="Absolute http(s) URL of the XML document")


def _finalize(stored: StoredXml) -> XmlDocModel:
    payload = stored.model.reformatted_xml.encode("utf-8")
    xml_id = hashlib.sha256(payload).hexdigest()[:32]
    stored.model.xml_id = xml_id
    xml_cache.put(xml_id, stored)
    logger.info(
        "xml parsed",
        extra={"ctx_xml_id": xml_id, "ctx_nodes": stored.model.node_count},
    )
    return stored.model


def _parse(data: bytes, filename: str, *, source: str, base_url: str | None = None) -> XmlDocModel:
    """Parse, cache and emit one ``xml_load`` usage event (ok or parse_error).

    ``base_url`` is passed on for resolving relative ``xsi:schemaLocation``
    values; it is only known for URL loads.
    """
    started = time.perf_counter()
    name = schema_display_name(source, filename)
    try:
        stored = parse_xml(data, filename, base_url=base_url)
    except (etree.XMLSyntaxError, SecurityError) as exc:
        detail = f"XML is not well-formed: {exc}" if isinstance(exc, etree.XMLSyntaxError) else str(exc)
        emit(
            "xml_load",
            source=source,
            schema_name=name,
            input_bytes=len(data),
            duration_ms=_ms(started),
            status="parse_error",
            status_code=400,
            error_detail=detail,
        )
        raise HTTPException(status_code=400, detail=detail) from exc
    model = _finalize(stored)
    emit(
        "xml_load",
        source=source,
        schema_name=name,
        input_bytes=len(data),
        file_count=1,
        element_count=model.node_count,
        duration_ms=_ms(started),
        status="ok",
        status_code=200,
    )
    return model


@router.post("/xml/upload", response_model=XmlDocModel)
@limiter.limit(WRITE_LIMIT)
async def upload_xml(request: Request, file: UploadFile) -> XmlDocModel:
    content = await read_upload(file, event_type="xml_load")
    return _parse(content, file.filename or "document.xml", source="upload")


@router.post("/xml/text", response_model=XmlDocModel)
@limiter.limit(WRITE_LIMIT)
async def upload_xml_text(request: Request, payload: TextPayload) -> XmlDocModel:
    data = payload.content.encode("utf-8")
    reject_oversized_text(data, event_type="xml_load", filename=payload.filename)
    return _parse(data, payload.filename, source="text")


@router.post("/xml/url", response_model=XmlDocModel)
@limiter.limit(WRITE_LIMIT)
async def upload_xml_url(request: Request, payload: UrlPayload) -> XmlDocModel:
    try:
        fetched = fetch_url(payload.url)
    except SecurityError as exc:
        raise reject(
            "xml_load", "url", 400, str(exc), schema_name=schema_display_name("url", payload.url)
        ) from exc
    return _parse(fetched.content, fetched.url, source="url", base_url=fetched.url)


@router.get("/xml/{xml_id}", response_model=XmlDocModel)
@limiter.limit(READ_LIMIT)
async def get_xml(request: Request, xml_id: str) -> XmlDocModel:
    stored = xml_cache.get(xml_id)
    if stored is None:
        raise HTTPException(status_code=404, detail="XML not found or expired")
    return stored.model
