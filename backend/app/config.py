from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# This file is backend/app/config.py, so the repo root is two levels up.
# Building the path from __file__ makes the .env load work no matter which
# directory you launch uvicorn / pytest / alembic from.
ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    database_hostname: str
    database_port: str = "5432"
    database_password: str
    database_name: str
    database_username: str
    secret_key: str
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60

    # Operational knobs — all have safe defaults, so .env only needs the
    # environment-specific secrets above.
    environment: str = "development"
    log_level: str = "INFO"
    rate_limit_enabled: bool = True

    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")


settings = Settings()
