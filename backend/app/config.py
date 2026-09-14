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
    # Short, because it no longer has to last a session: a stolen access token
    # is only useful until it expires, and /auth/refresh quietly replaces it.
    # Before refresh tokens this was 60 minutes and that *was* the session.
    access_token_expire_minutes: int = 15
    # The refresh cookie's life. Long enough that a browser you use weekly
    # stays signed in, short enough that an abandoned session goes away.
    refresh_token_expire_days: int = 14
    # Sent on the refresh cookie in production only: a Secure cookie is
    # dropped outright over plain http, which is every development machine.
    cookie_secure: bool = False

    # Operational knobs — all have safe defaults, so .env only needs the
    # environment-specific secrets above.
    environment: str = "development"
    log_level: str = "INFO"
    rate_limit_enabled: bool = True

    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")


settings = Settings()
