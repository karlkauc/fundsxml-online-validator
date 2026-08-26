"""User feedback endpoint — same contract as the XSD viewer's /api/feedback."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app import __version__
from app.feedback_store import FeedbackRow, FeedbackStore
from app.rate_limit import limiter

logger = logging.getLogger(__name__)

router = APIRouter(tags=["feedback"])

FEEDBACK_LIMIT = "5/minute"
_EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


def _truncate(value: str | None, limit: int = 255) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value[:limit] if value else None


class FeedbackPayload(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    email: str | None = Field(default=None, max_length=254, pattern=_EMAIL_PATTERN)
    page: str | None = Field(default=None, max_length=255)
    xml_name: str | None = Field(default=None, max_length=255)
    xsd_name: str | None = Field(default=None, max_length=255)
    error_detail: str | None = Field(default=None, max_length=255)
    # Honeypot: real users never see this field; bots that fill it are dropped silently.
    website: str | None = Field(default=None, max_length=255)


@router.post("/feedback", status_code=204)
@limiter.limit(FEEDBACK_LIMIT)
async def submit_feedback(request: Request, payload: FeedbackPayload) -> Response:
    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=422, detail="message must not be empty")
    if payload.website:
        return Response(status_code=204)

    row = FeedbackRow(
        message=message,
        email=(payload.email or "").strip() or None,
        page=_truncate(payload.page),
        xml_name=_truncate(payload.xml_name),
        xsd_name=_truncate(payload.xsd_name),
        error_detail=_truncate(payload.error_detail),
        user_agent=_truncate(request.headers.get("user-agent")),
        app_version=__version__,
    )

    store: FeedbackStore | None = getattr(request.app.state, "feedback", None)
    if store is not None and store.enabled:
        try:
            await store.save(row)
        except Exception as exc:  # noqa: BLE001 - report honestly, never 500
            logger.warning("feedback insert failed: %r", exc)
            raise HTTPException(
                status_code=503, detail="could not store feedback, please try again later"
            ) from exc
        logger.info("feedback stored", extra={"ctx_page": row.page, "ctx_has_email": bool(row.email)})
    else:
        # No database configured: keep the feedback in the (Cloud Run) log.
        logger.warning(
            "user feedback (no FEEDBACK_DB_URL configured)",
            extra={
                "ctx_page": row.page,
                "ctx_xml_name": row.xml_name,
                "ctx_xsd_name": row.xsd_name,
                "ctx_error_detail": row.error_detail,
                "ctx_email": row.email,
                "ctx_message": row.message,
            },
        )
    return Response(status_code=204)
