"""The prose half of the API: error responses and worked examples.

Kept out of the routers because it is documentation, not behaviour, and mixing
the two makes both harder to read — a route decorator carrying four paragraphs
of `responses=` buries the one line that says what the route does.

Two things live here:

``ERRORS`` — one entry per status code this API actually returns, written once
and spread into the routes that can return it (``**ERRORS[401]``). Before this
existed, `/docs` showed every endpoint as "200, or 422 Validation Error", which
is technically the generated truth and tells a client nothing about the 404
that separates "no such post" from "not yours".

``EXAMPLES`` — a worked response body per shape. FastAPI infers a schema from
the Pydantic model and fills the example with placeholder strings; a reader
skimming `/docs` learns much more from one realistic post than from
``{"title": "string", "content": "string"}``.

The examples are written to look like the seeded demo, so the document and the
thing at the end of the demo link are recognisably the same product.
"""

from typing import Any

from . import schemas

# ---------------------------------------------------------------------------
# Errors
#
# Every one of these is a `schemas.Detail`. The descriptions say what the code
# *means here*, not what it means in RFC 9110 — "404" is not interesting;
# "someone else's draft answers 404 so that a 403 can't confirm it exists" is.
# ---------------------------------------------------------------------------
ERRORS: dict[int, dict[int | str, dict[str, Any]]] = {
    400: {
        400: {
            "model": schemas.Detail,
            "description": "The request was understood and asks for nothing.",
        }
    },
    401: {
        401: {
            "model": schemas.Detail,
            "description": (
                "No access token, or one that has expired, been tampered with, "
                "or belongs to a deleted account. Trade the refresh cookie for "
                "a new token at `POST /auth/refresh` rather than sending the "
                "person back to a sign-in form."
            ),
        }
    },
    403: {
        403: {
            "model": schemas.Detail,
            "description": (
                "The post exists, is visible to you, and isn't yours. Used only "
                "where ownership is the question — never to hide a draft, which "
                "answers 404."
            ),
        }
    },
    404: {
        404: {
            "model": schemas.Detail,
            "description": (
                "No such row — or one you aren't allowed to know about. "
                "Somebody else's unpublished post answers this, deliberately, "
                "because a 403 would confirm that it exists."
            ),
        }
    },
    409: {
        409: {
            "model": schemas.Detail,
            "description": "That would collide with something already there.",
        }
    },
    422: {
        422: {
            "description": (
                "The body or the query string didn't validate. FastAPI's own "
                "shape: `detail` is a list of `{loc, msg, type}`, one per field."
            )
        }
    },
    429: {
        429: {
            "model": schemas.Detail,
            "description": "Rate limited. The message names the limit you hit.",
        }
    },
}


def errors(*codes: int) -> dict[int | str, dict[str, Any]]:
    """Spread the named error responses into a route: ``**errors(401, 404)``."""
    merged: dict[int | str, dict[str, Any]] = {}
    for code in codes:
        merged.update(ERRORS[code])
    return merged


# ---------------------------------------------------------------------------
# Example bodies
# ---------------------------------------------------------------------------
USER_EXAMPLE = {
    "id": 7,
    "username": "marenholt",
    "created_at": "2026-08-21T09:14:02.511Z",
}

ME_EXAMPLE = {**USER_EXAMPLE, "email": "maren.holt@example.com"}

POST_EXAMPLE = {
    "id": 12,
    "title": "The library that stays open all night",
    "content": (
        "There's a reading room near the old tram depot that never closes. No "
        "membership, no desk, no one checking whether you belong there."
    ),
    "published": True,
    "created_at": "2026-09-08T22:41:07.220Z",
    "updated_at": "2026-09-08T22:41:07.220Z",
    "user_id": 7,
    "user": USER_EXAMPLE,
    "votes": 4,
    "voted": False,
}

COMMENT_EXAMPLE = {
    "id": 31,
    "content": "I've walked past that wall a hundred times and never once thought about it.",
    "created_at": "2026-09-09T07:02:55.104Z",
    "post_id": 12,
    "user_id": 9,
    "user": {
        "id": 9,
        "username": "tessaward",
        "created_at": "2026-08-30T17:45:11.002Z",
    },
}


NOTIFICATION_EXAMPLE = {
    "id": 4,
    "kind": "reply",
    "created_at": "2026-09-09T07:14:30.881Z",
    "read_at": None,
    "actor": {
        "id": 9,
        "username": "tessaward",
        "created_at": "2026-08-30T17:45:11.002Z",
    },
    "post": {"id": 12, "title": "The library that stays open all night"},
    "excerpt": (
        "I've walked past that wall a hundred times and never once thought " "about it."
    ),
    "comment_id": 31,
}


def page(item: dict[str, Any], total: int = 14) -> dict[str, Any]:
    """The paging envelope around one worked item.

    Posts and comments come back in the identical shape on purpose — a client
    that can walk one can walk the other — so the example is built the same way
    for both rather than written out twice and allowed to drift.
    """
    return {
        "items": [item],
        "total": total,
        "page": 1,
        "page_size": 10,
        "pages": (total + 9) // 10,
        "has_next": total > 10,
        "has_prev": False,
    }


def ok(example: dict[str, Any], description: str | None = None) -> dict[str, Any]:
    """A 200/201 response carrying a worked example."""
    block: dict[str, Any] = {"content": {"application/json": {"example": example}}}
    if description:
        block["description"] = description
    return block
