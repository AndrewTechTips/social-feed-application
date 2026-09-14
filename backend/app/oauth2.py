import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, UTC

import jwt
from fastapi import Depends, Request, status, HTTPException
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from . import schemas
from . import database, models
from .config import settings

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")

SECRET_KEY = settings.secret_key
ALGORITHM = settings.algorithm
ACCESS_TOKEN_EXPIRE_MINUTES = settings.access_token_expire_minutes
REFRESH_TOKEN_EXPIRE_DAYS = settings.refresh_token_expire_days

# The name of the cookie the refresh token rides in, and the one path it is
# ever sent to. Both matter and the path matters most: everything that serves
# or changes content on this API authenticates with a Bearer header, so the
# cookie is attached to no content route at all. A forged cross-site request to
# POST /posts/ carries no credential the browser will attach, which is the
# property a bearer-header API has for free and a cookie API has to be built
# to keep.
REFRESH_COOKIE = "commons_refresh"
REFRESH_COOKIE_PATH = "/auth"
CSRF_HEADER = "X-CSRF-Token"

# How long the secret a rotation just replaced stays acceptable.
#
# Rotation is what makes a copied cookie detectable, and taken literally it
# also breaks two tabs. They share one cookie jar; reload both at once and both
# read the same cookie before either Set-Cookie lands, so the second request to
# arrive is presenting a secret that has already been spent. Without this
# window that is indistinguishable from a replay, and the answer to a replay is
# to end the session — which would mean an ordinary second tab silently signing
# you out of everything.
#
# Fifteen seconds is long enough for a slow request and a retry and short
# enough that a stolen cookie has to be used essentially immediately. It is a
# real narrowing of the detection and it is the trade every implementation of
# this makes; the alternative is a feature that is worse than what it replaced.
ROTATION_GRACE = timedelta(seconds=15)


def create_access_token(data: dict[str, object]) -> str:
    to_encode = data.copy()
    expire = datetime.now(UTC) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})

    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def verify_access_token(
    token: str, credentials_exception: HTTPException
) -> schemas.TokenData:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])

        user_id: int | None = payload.get("user_id")
        if user_id is None:
            raise credentials_exception

        token_data = schemas.TokenData(id=user_id)

    except jwt.InvalidTokenError:
        raise credentials_exception

    return token_data


def get_current_user(
    token: str = Depends(oauth2_scheme), db: Session = Depends(database.get_db)
) -> models.User:

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    token_data = verify_access_token(token, credentials_exception)
    stmt = select(models.User).where(models.User.id == token_data.id)
    user = db.scalar(stmt)

    if user is None:
        raise credentials_exception

    return user


def get_current_user_optional(
    request: Request, db: Session = Depends(database.get_db)
) -> models.User | None:
    """Like ``get_current_user``, but for routes that are public *and* show a
    little more to a signed-in caller (the feed shows you your own drafts).

    A missing or unusable token is not an error here — it just means "anonymous".
    We read the header by hand rather than reusing ``oauth2_scheme`` because
    OAuth2PasswordBearer raises a 401 when the header is absent, which is exactly
    what this dependency must not do.
    """
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.InvalidTokenError:
        return None

    user_id = payload.get("user_id")
    if user_id is None:
        return None

    return db.scalar(select(models.User).where(models.User.id == user_id))


# ---------------------------------------------------------------------------
# Refresh sessions
#
# The split is the ordinary one: a short-lived access token the client holds in
# memory and sends as a Bearer header, and a long-lived refresh token that only
# ever travels in an httpOnly cookie and only ever to /auth. The client cannot
# read the second one, which is the whole point — an XSS bug on the frontend
# can use the session for as long as the page is open and cannot walk away
# with it.
#
# The refresh token is opaque, not a JWT: "<family id>.<secret>". Nothing in it
# needs to be readable by anyone, a lookup has to happen anyway to rotate it,
# and an opaque string can never be mistaken for an access token by either side.
# ---------------------------------------------------------------------------


def _hash(value: str) -> str:
    """SHA-256 hex. Not bcrypt, on purpose.

    Passwords are hashed slowly because they are short, guessable, and chosen
    by people. These are 256 bits from ``secrets``: there is nothing to guess,
    so a slow hash would only buy a slow endpoint. And the row is found by
    exact hash lookup rather than by comparing candidates, so there is no
    timing signal in the comparison either.
    """
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _split(raw: str) -> tuple[str, str] | None:
    """Pull "<family>.<secret>" apart, or say the cookie is not one of ours."""
    family, _, secret = raw.partition(".")
    if not family or not secret:
        return None
    return family, secret


def _rotate(session_row: models.RefreshSession) -> str:
    """Mint a fresh secret into an existing session row, keeping the last one
    acceptable for ROTATION_GRACE.

    Returns the cookie value in the clear — the only moment the secret exists
    outside a hash.
    """
    secret = secrets.token_urlsafe(32)
    session_row.previous_hash = session_row.token_hash or None
    session_row.rotated_at = datetime.now(UTC)
    session_row.token_hash = _hash(secret)
    return f"{session_row.id}.{secret}"


def open_refresh_session(db: Session, user: models.User) -> tuple[str, str]:
    """Start a new session for a successful sign-in.

    Also the one place housekeeping happens: a person signing in is the moment
    their own dead rows are cheapest to be rid of, and it means no cron job and
    no sweeper process for a table that only grows by one row per sign-in.
    """
    now = datetime.now(UTC)
    db.execute(
        delete(models.RefreshSession).where(
            models.RefreshSession.user_id == user.id,
            or_(
                models.RefreshSession.expires_at <= now,
                models.RefreshSession.revoked_at.is_not(None),
            ),
        )
    )

    row = models.RefreshSession(
        id=uuid.uuid4().hex,
        user_id=user.id,
        token_hash="",
        # Issued once, here, and handed back unchanged on every refresh for the
        # life of the session — see the note on the column.
        csrf_token=secrets.token_urlsafe(32)[:64],
        expires_at=now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
    )
    token = _rotate(row)
    db.add(row)
    db.commit()
    return token, row.csrf_token


class RefreshRejected(Exception):
    """The refresh didn't check out.

    Every failure is answered with the same 401 and the same body: telling a
    caller *which* way their refresh token was wrong is telling an attacker
    whether they hold half of a real one.

    ``clear`` is the one thing that differs, and it is not visible in the
    response body. A cookie that is missing, forged, expired, revoked or
    replayed can only ever fail again, so it is expired on the way out. A
    *good* cookie presented without a matching CSRF token is a different
    statement — "this request didn't come from our page" — and the right answer
    to it is to refuse the request and change nothing. Clearing there would
    turn a forged request into a forced sign-out, which is a small denial of
    service but a real one.
    """

    def __init__(self, *, clear: bool = True) -> None:
        super().__init__("refresh rejected")
        self.clear = clear


def rotate_refresh_session(
    db: Session, raw: str | None, csrf_token: str | None
) -> tuple[models.User, str, str]:
    """Swap a refresh token for the next one, and for a new access token.

    Every success invalidates the token that was presented. That is what makes
    a copied cookie detectable at all: two browsers holding the same secret
    will both eventually present it, and the second one arrives with a family
    that exists and a secret that has already been rotated away. There is no
    way to tell which of the two is the thief, so the answer is to end the
    family and make both sign in again.
    """
    if not raw:
        raise RefreshRejected

    parts = _split(raw)
    if parts is None:
        raise RefreshRejected
    family, secret = parts

    row = db.get(models.RefreshSession, family)
    if row is None:
        raise RefreshRejected

    if row.revoked_at is not None or row.expires_at <= datetime.now(UTC):
        raise RefreshRejected

    presented = _hash(secret)
    if not secrets.compare_digest(row.token_hash, presented):
        # Not the current secret. One case is innocent and one is not.
        graced = (
            row.previous_hash is not None
            and row.rotated_at is not None
            and secrets.compare_digest(row.previous_hash, presented)
            and datetime.now(UTC) - row.rotated_at <= ROTATION_GRACE
        )
        if not graced:
            # A live family, an old secret, and no window left to explain it:
            # the cookie was copied. There is no way to tell which holder is
            # the thief, so neither of them gets to stay.
            row.revoked_at = datetime.now(UTC)
            db.commit()
            raise RefreshRejected

    # Only now, with the cookie proven, is the CSRF token worth checking — and
    # it is checked here rather than in a dependency so that no request can
    # reach the rotation below without having passed it.
    if not csrf_token or not secrets.compare_digest(row.csrf_token, csrf_token):
        # The session is fine; this request isn't ours. Leave the cookie alone.
        raise RefreshRejected(clear=False)

    user = db.get(models.User, row.user_id)
    if user is None:
        # The cascade should have taken the row with the account. If it somehow
        # didn't, a session with nobody behind it is not a session.
        raise RefreshRejected

    token = _rotate(row)
    db.commit()
    return user, token, row.csrf_token


def close_refresh_session(db: Session, raw: str | None, csrf_token: str | None) -> None:
    """Sign out: revoke the family the cookie names.

    Never raises. Signing out is the one operation that has to work from a bad
    state — a cookie that expired while the tab was open, a session already
    revoked from another device — because the alternative is an error message
    in front of someone who has asked to leave. The CSRF check still applies:
    forcing a stranger to sign out is a small attack, but it is one.
    """
    if not raw:
        return
    parts = _split(raw)
    if parts is None:
        return
    family, secret = parts

    row = db.get(models.RefreshSession, family)
    if row is None or row.revoked_at is not None:
        return
    presented = _hash(secret)
    if not secrets.compare_digest(row.token_hash, presented) and not (
        row.previous_hash is not None
        and secrets.compare_digest(row.previous_hash, presented)
    ):
        return
    if not csrf_token or not secrets.compare_digest(row.csrf_token, csrf_token):
        return

    row.revoked_at = datetime.now(UTC)
    db.commit()
