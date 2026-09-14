import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded

from .config import settings
from .limiter import limiter
from .logging_config import configure_logging
from .routers import post, user, auth, vote, comment

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    logger.info("Starting Social Feed API (environment=%s)", settings.environment)
    yield
    logger.info("Shutting down Social Feed API")


app = FastAPI(title="Social Feed API", lifespan=lifespan)

# slowapi needs the limiter on app.state plus a handler for its exception
app.state.limiter = limiter

origins = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    # No allow_credentials: auth here is a Bearer header, not a cookie, so
    # nothing needs credentialed CORS. Turning it on would only widen what a
    # browser is willing to send on our behalf.
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
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
async def security_headers(request: Request, call_next):
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
async def log_requests(request: Request, call_next):
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
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        content={"detail": f"Rate limit exceeded: {exc.detail}"},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # Log the full traceback server-side, return a generic message to the client
    # so internal details never leak.
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal server error"},
    )


app.include_router(post.router)
app.include_router(user.router)
app.include_router(auth.router)
app.include_router(vote.router)
app.include_router(comment.router)


@app.get("/")
def root():
    return {"message": "Welcome to my api"}


@app.get("/healthz", tags=["Health"])
def healthz():
    return {"status": "ok"}
