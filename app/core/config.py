from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT_DIR / ".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = "Clipforge API"
    app_env: Literal["development", "test", "production"] = "development"
    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/clipforge"
    allowed_origins: Annotated[list[str], NoDecode] = ["*"]
    secret_key: str = "change-me-in-phase-2"
    redis_url: str = "redis://localhost:6379/0"

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def parse_allowed_origins(cls, value: object) -> list[str]:
        if value in (None, ""):
            return ["*"]
        if isinstance(value, list):
            return [str(origin).strip() for origin in value if str(origin).strip()]
        if isinstance(value, str):
            raw_value = value.strip()
            if not raw_value:
                return ["*"]
            if raw_value.startswith("["):
                parsed = json.loads(raw_value)
                return [str(origin).strip() for origin in parsed if str(origin).strip()]
            return [origin.strip() for origin in raw_value.split(",") if origin.strip()]
        raise ValueError("ALLOWED_ORIGINS must be a comma-separated string or JSON list.")

    @property
    def is_development(self) -> bool:
        return self.app_env == "development"


@lru_cache
def get_settings() -> Settings:
    return Settings()
