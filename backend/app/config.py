"""Runtime configuration loaded from environment variables."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass


@dataclass
class Settings:
    port: int
    max_upload_mb: int
    allowed_schema_hosts: tuple[re.Pattern[str], ...]
    cache_ttl_min: int
    cache_max_entries: int
    log_level: str
    static_dir: str
    fetch_timeout_seconds: float
    fetch_max_response_mb: int
    fetch_max_redirects: int
    cors_allow_origins: tuple[str, ...]
    max_zip_entries: int
    max_zip_uncompressed_mb: int
    max_zip_ratio: int
    max_xml_nodes: int
    feedback_db_url: str
    feedback_db_password: str

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def fetch_max_response_bytes(self) -> int:
        return self.fetch_max_response_mb * 1024 * 1024

    @property
    def max_zip_uncompressed_bytes(self) -> int:
        return self.max_zip_uncompressed_mb * 1024 * 1024


def _parse_host_patterns(raw: str) -> tuple[re.Pattern[str], ...]:
    """ALLOWED_SCHEMA_HOSTS accepts one or more regexes, comma-separated."""
    if not raw.strip():
        return ()
    patterns = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            patterns.append(re.compile(part))
        except re.error as exc:
            raise ValueError(f"Invalid regex in ALLOWED_SCHEMA_HOSTS: {part!r}: {exc}") from exc
    return tuple(patterns)


def _parse_origins(raw: str) -> tuple[str, ...]:
    return tuple(p.strip() for p in raw.split(",") if p.strip())


def load_settings() -> Settings:
    return Settings(
        port=int(os.getenv("PORT", "8080")),
        max_upload_mb=int(os.getenv("MAX_UPLOAD_MB", "50")),
        allowed_schema_hosts=_parse_host_patterns(os.getenv("ALLOWED_SCHEMA_HOSTS", "")),
        cache_ttl_min=int(os.getenv("CACHE_TTL_MIN", "60")),
        cache_max_entries=int(os.getenv("CACHE_MAX_ENTRIES", "64")),
        log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
        static_dir=os.getenv("STATIC_DIR", "/app/static"),
        fetch_timeout_seconds=float(os.getenv("FETCH_TIMEOUT_SECONDS", "10")),
        fetch_max_response_mb=int(os.getenv("FETCH_MAX_RESPONSE_MB", "10")),
        fetch_max_redirects=int(os.getenv("FETCH_MAX_REDIRECTS", "3")),
        cors_allow_origins=_parse_origins(os.getenv("CORS_ALLOW_ORIGINS", "")),
        max_zip_entries=int(os.getenv("MAX_ZIP_ENTRIES", "2000")),
        max_zip_uncompressed_mb=int(os.getenv("MAX_ZIP_UNCOMPRESSED_MB", "200")),
        max_zip_ratio=int(os.getenv("MAX_ZIP_RATIO", "200")),
        max_xml_nodes=int(os.getenv("MAX_XML_NODES", "500000")),
        feedback_db_url=os.getenv("FEEDBACK_DB_URL", ""),
        feedback_db_password=os.getenv("FEEDBACK_DB_PASSWORD", ""),
    )


settings = load_settings()
