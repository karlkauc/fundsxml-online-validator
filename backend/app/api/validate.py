"""Validate a cached XML document against a cached XSD; download Excel report."""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.api._common import _ms, reject
from app.cache import validation_cache, xml_cache, xsd_cache
from app.parser.validate import ValidationResponse, validate
from app.parser.xsd_store import XsdError
from app.rate_limit import READ_LIMIT, WRITE_LIMIT, limiter
from app.report.excel import build_report
from app.usage.context import emit
from app.usage.events import truncate

logger = logging.getLogger(__name__)

router = APIRouter(tags=["validate"])


class ValidatePayload(BaseModel):
    xml_id: str = Field(..., description="id of a previously uploaded XML document")
    xsd_id: str = Field(..., description="id of a previously uploaded XSD schema")


@dataclass
class StoredValidation:
    response: ValidationResponse
    xml_filename: str
    xsd_filename: str
    reformatted_xml: str


@router.post("/validate", response_model=ValidationResponse)
@limiter.limit(WRITE_LIMIT)
async def run_validation(request: Request, payload: ValidatePayload) -> ValidationResponse:
    started = time.perf_counter()
    stored_xml = xml_cache.get(payload.xml_id)
    if stored_xml is None:
        raise reject("validate", None, 404, "XML not found or expired")
    stored_xsd = xsd_cache.get(payload.xsd_id)
    if stored_xsd is None:
        raise reject("validate", None, 404, "XSD not found or expired")
    input_bytes = len(stored_xml.model.reformatted_xml.encode("utf-8"))
    schema_name = truncate(stored_xsd.main_filename)

    try:
        result = validate(stored_xml, stored_xsd)
    except XsdError as exc:
        emit(
            "validate",
            source=None,
            schema_name=schema_name,
            input_bytes=input_bytes,
            duration_ms=_ms(started),
            status="parse_error",
            status_code=422,
            error_detail=str(exc),
        )
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    validation_id = hashlib.sha256(
        f"{payload.xml_id}:{payload.xsd_id}".encode()
    ).hexdigest()[:32]
    result.validation_id = validation_id
    validation_cache.put(
        validation_id,
        StoredValidation(
            response=result,
            xml_filename=stored_xml.model.filename,
            xsd_filename=stored_xsd.main_filename,
            reformatted_xml=stored_xml.model.reformatted_xml,
        ),
    )
    logger.info(
        "validation completed",
        extra={
            "ctx_validation_id": validation_id,
            "ctx_is_valid": result.is_valid,
            "ctx_errors": len(result.errors),
        },
    )
    emit(
        "validate",
        source=None,
        schema_name=schema_name,
        input_bytes=input_bytes,
        error_count=len(result.errors),
        duration_ms=_ms(started),
        status="ok" if result.is_valid else "invalid",
        status_code=200,
    )
    return result


@router.get("/validate/{validation_id}/excel")
@limiter.limit(READ_LIMIT)
async def download_excel(request: Request, validation_id: str) -> StreamingResponse:
    stored = validation_cache.get(validation_id)
    if stored is None:
        emit("export", source="excel", status="rejected", status_code=404)
        raise HTTPException(status_code=404, detail="validation result not found or expired")
    emit(
        "export",
        source="excel",
        schema_name=truncate(stored.xsd_filename),
        error_count=len(stored.response.errors),
        status="ok",
        status_code=200,
    )
    data = build_report(
        stored.response,
        xml_filename=stored.xml_filename,
        xsd_filename=stored.xsd_filename,
        reformatted_xml=stored.reformatted_xml,
    )
    filename = f"validation_report_{validation_id[:8]}.xlsx"
    return StreamingResponse(
        iter([data]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
