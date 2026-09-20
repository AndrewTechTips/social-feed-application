from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import URL

# This file is backend/app/config.py, so the repo root is two levels up.
# Building the path from __file__ makes the .env load work no matter which
# directory you launch uvicorn / pytest / alembic from.
ENV_FILE = Path(__file__).resolve().parents[2] / ".env"

# Every route the app serves lives under this, and nothing else does.
#
# A constant rather than a setting, because it is not configurable: it is part
# of the contract, and a deployment that could change it would be a deployment
# that could break every client by editing an environment variable.
#
# What is *not* under it: `/` and `/healthz`. A liveness probe is asked for by
# the thing running the container rather than by a client of the API, and it
# has to keep answering across a version bump — which is the whole point of
# there being versions.
#
# It is worth knowing what this cost, once, at the moment it was added: the
# refresh cookie's Path moves with it, so every browser holding a cookie issued
# at `/auth` stopped sending it and had to sign in again. That is the cheapest
# this change will ever be, which is the argument for doing it now rather than
# when somebody's script depends on the old paths.
API_PREFIX = "/api/v1"


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
    # Whether to put `Secure` on the refresh cookie. Unset means "decide from
    # the environment" — see secure_cookies below, which is what everything
    # actually reads.
    cookie_secure: bool | None = None

    # Operational knobs — all have safe defaults, so .env only needs the
    # environment-specific secrets above.
    environment: str = "development"
    log_level: str = "INFO"
    rate_limit_enabled: bool = True

    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")

    def database_url(self, suffix: str = "") -> URL:
        """The connection URL, assembled rather than formatted.

        This used to be an f-string in three places, and an f-string is wrong
        here for one specific reason: a URL has reserved characters and a
        password is a place people put them. A password containing `@`, `:`,
        `/` or `#` produces a string that parses — just not into the database
        you meant. `foo@bar` as a password moves the host boundary and the
        driver goes looking for a server called `bar`.

        `URL.create` takes the parts as parts and does its own percent-encoding
        at render time, so there is no string for a password to be misread in.
        The one-liner it replaces was also duplicated in `alembic/env.py` and
        in the test conftest, which meant three chances to fix it and two
        chances to forget.

        `suffix` is for the test database, which is the same connection with
        `_test` on the end of the name.
        """
        return URL.create(
            "postgresql",
            username=self.database_username,
            password=self.database_password,
            host=self.database_hostname,
            port=int(self.database_port),
            database=f"{self.database_name}{suffix}",
        )

    @property
    def secure_cookies(self) -> bool:
        """Secure by default in production, off by default anywhere else.

        The flag can't simply default to True: a Secure cookie is dropped
        outright by the browser over plain http, and every development machine
        is plain http — so a True default would make the refresh flow fail
        locally with no error message anywhere, which is a bad afternoon.

        It can't safely default to False either. That is the one setting where
        forgetting it in production sends the credential this app can least
        afford to lose over the wire in the clear, and a deployment checklist
        is a poor place to keep a security property.

        So it follows `environment`, and an explicit COOKIE_SECURE still wins —
        for the case this doesn't cover, which is TLS terminated in front of a
        service that doesn't call itself production.
        """
        if self.cookie_secure is not None:
            return self.cookie_secure
        return self.environment == "production"


settings = Settings()
