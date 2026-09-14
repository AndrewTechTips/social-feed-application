"""Signing in, staying signed in, and signing out.

Three endpoints and one idea: the thing the client holds is short-lived and the
thing that keeps it signed in is not readable by the client at all.

``POST /login``          email + password  → access token, and a refresh cookie
``POST /auth/refresh``   the refresh cookie → a new access token, and a new cookie
``POST /auth/logout``    the refresh cookie → revoked, and cleared

The access token is returned in the body because that is where the client wants
it: it lives in a variable, never in storage, and goes out as a Bearer header.
The refresh token is returned in a ``Set-Cookie`` because that is the one place
the client *can't* get at it. Splitting them is the entire security argument —
see docs/adr/0003-token-in-an-httponly-cookie.md.
"""

from fastapi import APIRouter, Depends, Request, Response, status, HTTPException
from fastapi.responses import JSONResponse
from fastapi.security.oauth2 import OAuth2PasswordRequestForm
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import database, schemas, models, utils, oauth2
from ..config import settings
from ..limiter import limiter

router = APIRouter(tags=["Authentication"])

INVALID_CREDENTIALS = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Invalid Credentials",
    headers={"WWW-Authenticate": "Bearer"},
)


def _set_refresh_cookie(response: Response, token: str) -> None:
    """Attach the refresh cookie, with every flag that makes it one.

    ``httponly`` is the point of the exercise: no script on the page can read
    this value, so an XSS bug can act as the user while the tab is open and
    cannot take the session away with it.

    ``samesite="lax"`` is the CSRF floor. The cookie is only sent to /auth, and
    a cross-*site* POST doesn't carry it at all. Worth knowing where the line
    falls in development: the frontend on ``localhost:5173`` and this API on
    ``localhost:8000`` are different origins but the *same site* — cookies
    ignore the port — so Lax lets it through. Serving the frontend from
    ``127.0.0.1`` instead would make it cross-site and the cookie would vanish,
    which is a confusing hour if you don't know to expect it.

    ``secure`` is off by default because a Secure cookie is dropped over plain
    http and every development machine is plain http; settings.cookie_secure
    turns it on where there is TLS to turn it on for.
    """
    response.set_cookie(
        key=oauth2.REFRESH_COOKIE,
        value=token,
        max_age=settings.refresh_token_expire_days * 24 * 60 * 60,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path=oauth2.REFRESH_COOKIE_PATH,
    )


def _clear_refresh_cookie(response: Response) -> None:
    """Expire the cookie, with the same flags it was set with.

    The flags matter on the way out as much as on the way in: a browser will
    only replace a cookie with one whose name, path and domain match, so
    clearing it with a different path leaves the original sitting there.
    """
    response.delete_cookie(
        key=oauth2.REFRESH_COOKIE,
        path=oauth2.REFRESH_COOKIE_PATH,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
    )


def _token_body(access_token: str, csrf_token: str) -> dict[str, object]:
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "expires_in": settings.access_token_expire_minutes * 60,
        # Not a secret in the way the other two are: it exists so that a
        # request to /auth can prove it was made by code that could read this
        # response, which a cross-site forgery cannot. It is handed over in the
        # body rather than in a readable cookie because the frontend is on a
        # different origin and could not read that cookie either.
        "csrf_token": csrf_token,
    }


@router.post(
    "/login",
    response_model=schemas.Token,
    summary="Sign in",
    responses={
        401: {
            "model": schemas.Detail,
            "description": (
                "The email and password don't match. Deliberately the same "
                "answer whether or not the address has an account."
            ),
        },
        429: {"model": schemas.Detail, "description": "Too many attempts (5/minute)."},
    },
)
@limiter.limit("5/minute")
def login(
    request: Request,
    response: Response,
    user_credentials: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(database.get_db),
) -> dict[str, object]:
    """Exchange an email and a password for an access token and a refresh cookie.

    The form field is called `username` because that is what the OAuth2
    password flow calls it, and `/docs` builds its form from the same spec.
    This API signs people in by **email** — the username is the public identity
    and is not a credential.
    """
    stmt = select(models.User).where(models.User.email == user_credentials.username)
    user = db.scalar(stmt)

    if not user:
        # Spend the same time here as the branch below does, so how long the
        # response takes doesn't reveal whether this email has an account.
        utils.verify_password_dummy()
        raise INVALID_CREDENTIALS

    if not utils.verify_password(user_credentials.password, user.password):
        raise INVALID_CREDENTIALS

    refresh_token, csrf_token = oauth2.open_refresh_session(db, user)
    _set_refresh_cookie(response, refresh_token)
    return _token_body(oauth2.create_access_token({"user_id": user.id}), csrf_token)


auth_router = APIRouter(prefix="/auth", tags=["Authentication"])


@auth_router.post(
    "/refresh",
    response_model=schemas.Token,
    summary="Trade the refresh cookie for a new access token",
    responses={
        401: {
            "model": schemas.Detail,
            "description": (
                "No usable refresh cookie, or no matching `X-CSRF-Token`. One "
                "answer for every way of being wrong — saying which would tell "
                "a caller whether they hold half of a real session. The cookie "
                "is cleared, because whatever is in the browser is no longer "
                "worth sending."
            ),
        },
        429: {"model": schemas.Detail, "description": "Too many attempts (30/minute)."},
    },
)
@limiter.limit("30/minute")
def refresh(
    request: Request,
    response: Response,
    db: Session = Depends(database.get_db),
) -> dict[str, object] | JSONResponse:
    """Rotate the session.

    Every call invalidates the token that was presented and issues the next
    one, so a copied cookie is detectable: the copy eventually presents a
    secret that has already been rotated away, and the whole session is ended
    rather than guessing which of the two holders is the thief.

    Send the `csrf_token` from the last `/login` or `/auth/refresh` response in
    an `X-CSRF-Token` header. Without it this answers 401 even with a perfectly
    good cookie.
    """
    try:
        user, refresh_token, csrf_token = oauth2.rotate_refresh_session(
            db,
            request.cookies.get(oauth2.REFRESH_COOKIE),
            request.headers.get(oauth2.CSRF_HEADER),
        )
    except oauth2.RefreshRejected as rejected:
        # Built by hand rather than raised, because the point of this branch is
        # the Set-Cookie on it and an HTTPException loses it: FastAPI answers a
        # raised exception with a response of its own making, and the headers
        # put on the injected `response` above never reach the client.
        #
        # Clearing it matters. The browser is holding something that can only
        # ever fail again, and leaving it there means every future request to
        # /auth carries a dead credential — and, once it is gone, the frontend
        # can tell "signed out" from "temporarily broken".
        answer = JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"detail": "Invalid Credentials"},
            headers={"WWW-Authenticate": "Bearer"},
        )
        if rejected.clear:
            _clear_refresh_cookie(answer)
        return answer

    _set_refresh_cookie(response, refresh_token)
    return _token_body(oauth2.create_access_token({"user_id": user.id}), csrf_token)


@auth_router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Sign out",
    responses={
        204: {
            "description": (
                "Signed out. Answered whether or not there was a session to "
                "end — a caller asking to leave should never be told no."
            )
        }
    },
)
def logout(
    request: Request,
    response: Response,
    db: Session = Depends(database.get_db),
) -> None:
    """End the session this cookie belongs to, and clear the cookie.

    Revokes server-side rather than only clearing the cookie, which is most of
    why the sessions are in a table at all: clearing a cookie ends a session on
    one machine, revoking it ends the session.
    """
    presented = request.cookies.get(oauth2.REFRESH_COOKIE)
    oauth2.close_refresh_session(db, presented, request.headers.get(oauth2.CSRF_HEADER))
    # Only clear what was actually sent. A cross-site form POST to this path
    # carries no cookie — SameSite=Lax sees to that — so clearing regardless
    # would let any page on the internet sign a reader out by asking.
    if presented:
        _clear_refresh_cookie(response)
