import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded

from .config import settings, API_PREFIX
from .limiter import limiter
from .logging_config import configure_logging
from .routers import post, user, auth, vote, comment, notification, shelf

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    configure_logging()
    logger.info("Starting Social Feed API (environment=%s)", settings.environment)
    yield
    logger.info("Shutting down Social Feed API")


# Tag descriptions. /docs renders these above each group, and they are the only
# prose a reader gets before a list of paths — so each one says what the group
# is *for*, not what its name already says.
TAGS_METADATA = [
    {
        "name": "Authentication",
        "description": (
            "Two tokens, on purpose. A short-lived **access token** comes back "
            "in the response body and goes out as `Authorization: Bearer …`; a "
            "long-lived **refresh token** goes out in an httpOnly cookie scoped "
            "to `/auth`, where no script on the page can read it and no content "
            "route ever sees it. `POST /auth/refresh` trades one for the other "
            "and rotates both.\n\n"
            "`/login` takes an **email**, not a username — the form field is "
            "called `username` because the OAuth2 password flow names it that."
        ),
    },
    {
        "name": "Posts",
        "description": (
            "The feed and everything on it. Reading is public; writing needs a "
            "token. One rule runs through all of it: an unpublished post is "
            "visible to its author and to nobody else, and to anyone else it "
            "answers **404** rather than 403 — a 403 would confirm it exists."
        ),
    },
    {
        "name": "Comments",
        "description": (
            "Remarks on a post, oldest first, in the same page envelope the "
            "feed uses. A comment is yours to remove and nobody else's — not "
            "even the author of the post it sits on."
        ),
    },
    {
        "name": "Users",
        "description": (
            "Accounts and public identities. The **username** is what everyone "
            "sees; the **email** is a credential and leaves the server on "
            "exactly one endpoint, `GET /users/me`, where the caller is the "
            "only person it belongs to."
        ),
    },
    {
        "name": "Shelf",
        "description": (
            "Posts saved to read later. A shelf is a **set**, so saving is "
            "idempotent — `PUT` and `DELETE` both answer 204 whether or not "
            "anything changed, and a client never has to treat one of its own "
            "errors as success."
        ),
    },
    {
        "name": "Vote",
        "description": (
            "One upvote per person per post. There is no downvote — the only "
            "live quantity in this product is agreement."
        ),
    },
    {"name": "Health", "description": "Is the process up and serving."},
]

app = FastAPI(
    title="Social Feed API",
    version="1.0.0",
    lifespan=lifespan,
    openapi_tags=TAGS_METADATA,
    description=(
        "The backend behind **Commons** — a small public feed.\n\n"
        "Posts, comments, upvotes and accounts, with a two-token auth flow. "
        "Reading is public; writing needs an account.\n\n"
        "The published demo at "
        "[andrewtechtips.github.io/social-feed-application]"
        "(https://andrewtechtips.github.io/social-feed-application/) "
        "reimplements this same contract in the browser, because a static host "
        "has nowhere to run FastAPI. This document is the contract both of them "
        "answer to."
    ),
    # Not a deployment: this API has no public home, and saying otherwise in the
    # spec would be the one dishonest line in the repo. What a `servers` block
    # buys here is a working "Try it out" in /docs against a local process, and
    # a generated client that points somewhere real the moment you run one.
    servers=[
        {"url": "http://localhost:8000", "description": "A local development server"}
    ],
    contact={
        "name": "Source on GitHub",
        "url": "https://github.com/AndrewTechTips/social-feed-application",
    },
    license_info={
        "name": "MIT",
        "url": (
            "https://github.com/AndrewTechTips/social-feed-application"
            "/blob/main/LICENSE"
        ),
    },
)

# slowapi needs the limiter on app.state plus a handler for its exception
app.state.limiter = limiter

# Credentialed CORS, which means this list is now load-bearing in a way it
# wasn't: the refresh cookie is only ever sent by a browser to an origin the
# list below names, and `allow_credentials=True` makes `allow_origins=["*"]`
# illegal rather than merely unwise — Starlette echoes the caller's origin
# instead of a wildcard, so a wildcard would echo *anything*. Keep it explicit
# and keep it short.
origins = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    # On, now that there is a cookie. It is what lets the frontend on :5173
    # receive the Set-Cookie from :8000 at all — and note what it does *not*
    # widen: the cookie is scoped to /auth, so no content route gains an
    # ambient credential from this.
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    # If-None-Match has to be allowed in, or the preflight refuses the
    # conditional request before it is ever made.
    allow_headers=["Authorization", "Content-Type", "X-CSRF-Token", "If-None-Match"],
    # And ETag has to be let back out. A cross-origin response only hands
    # JavaScript the seven CORS-safelisted headers unless the server names
    # others here — so without this line the browser receives the validator,
    # keeps it for its own HTTP cache, and `res.headers.get("ETag")` is null.
    # The feature then fails silently: every request is unconditional and
    # everything still works, which is the worst way for it to be broken.
    expose_headers=["ETag"],
)


# Sent on every response. None of these matter much for a JSON API consumed by
# fetch(), but /docs is HTML served from this same origin, and they cost one
# dict lookup.
SECURITY_HEADERS = {
    # don't let a browser second-guess a Content-Type it was given
    "X-Content-Type-Options": "nosniff",
    # nothing here is meant to be framed
    "X-Frame-Options": "DENY",
    # don't leak the full URL (ids included) to other origins
    "Referrer-Policy": "no-referrer",
    # this API has no use for any of them
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
}


@app.middleware("http")
async def security_headers(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    response = await call_next(request)
    for header, value in SECURITY_HEADERS.items():
        response.headers.setdefault(header, value)
    # HSTS only means something over TLS, and asserting it in development would
    # pin localhost to https in the browser's cache for a year.
    if settings.environment == "production":
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
        )
    return response


@app.middleware("http")
async def log_requests(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    start = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - start) * 1000
    logger.info(
        "%s %s -> %s (%.1f ms)",
        request.method,
        request.url.path,
        response.status_code,
        elapsed_ms,
    )
    return response


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        content={"detail": f"Rate limit exceeded: {exc.detail}"},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # Log the full traceback server-side, return a generic message to the client
    # so internal details never leak.
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal server error"},
    )


# One place that knows where the API lives.
#
# The alternative — a prefix argument on each of the six routers — is the same
# string written six times, and six places for the seventh router somebody adds
# next year to disagree with. Nesting them under one parent also means the
# prefix appears once in the OpenAPI document's construction rather than being
# reassembled from the parts.
api = APIRouter(prefix=API_PREFIX)
api.include_router(post.router)
api.include_router(user.router)
api.include_router(auth.router)
api.include_router(auth.auth_router)
api.include_router(vote.router)
api.include_router(comment.router)
api.include_router(shelf.router)
api.include_router(notification.router)
app.include_router(api)


@app.get("/", include_in_schema=False)
def root() -> dict[str, str]:
    return {"message": "Welcome to my api"}


@app.get(
    "/healthz",
    tags=["Health"],
    summary="Liveness probe",
    responses={200: {"content": {"application/json": {"example": {"status": "ok"}}}}},
)
def healthz() -> dict[str, str]:
    """Answers as long as the process is serving.

    Deliberately does *not* touch the database: a health check that fails when
    Postgres is slow turns one degraded dependency into a restart loop.
    """
    return {"status": "ok"}
