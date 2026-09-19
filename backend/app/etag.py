"""Conditional requests on the reads that are worth making conditional.

An `ETag` is a fingerprint of a response, and `If-None-Match` is the client
handing it back to ask "has this changed?". If it hasn't, the answer is a `304`
with no body at all.

── what this actually saves, and what it does not ──────────────────────────
Worth being exact, because the obvious claim for it is wrong.

It does **not** save the server any work. The fingerprint is taken from the
rendered response, so by the time this code can decide to answer `304` the
query has run, the rows have been fetched and the JSON has been built. Every
database round trip happens either way. Anyone reaching for this to make an
endpoint cheap to *serve* has reached for the wrong tool: that is what a cached
validator computed before the query would be for, and this is not that.

What it saves is **bytes on the wire and parsing on the client**. A page of the
feed is a few kilobytes of JSON; a `304` is a couple of hundred bytes of
headers. On a phone on a bad connection that is the difference worth having,
and it is the reason browsers have implemented this since 1997.

The upgrade plan claimed it would make the "new posts" poll almost free. It
doesn't. That poll asks for `page_size=1`, so its body is already tiny and the
saving is close to nothing. It is applied to the feed because the *feed* is
where the kilobytes are.

── why a route class rather than middleware ────────────────────────────────
Middleware would have to buffer every response in the application to fingerprint
the few that want it, and it would run outside the route's own serialization —
which is to say outside `response_model`, the thing that guarantees a `PostOut`
is a `PostOut`. A route class wraps the handler *after* FastAPI has validated
and rendered, so the schema still does its job and only the routes that opt in
pay anything.
"""

import hashlib
from typing import Callable, Coroutine, Any

from fastapi import Request, Response
from fastapi.routing import APIRoute


# Weak, and the `W/` is not decoration. A strong validator promises the bytes
# are identical, which is a promise about serialization order that nothing here
# makes. Weak promises the *representation* is equivalent, which is exactly what
# is being claimed.
def _fingerprint(body: bytes) -> str:
    return f'W/"{hashlib.blake2b(body, digest_size=16).hexdigest()}"'


class ETagRoute(APIRoute):
    """Fingerprint GET responses, and answer 304 when the client already has it."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def with_etag(request: Request) -> Response:
            response = await handler(request)

            # Only a plain, whole, successful GET. A 404 has nothing worth
            # fingerprinting, a 206 is already a conditional answer to a
            # different question, and a body this code cannot see is a body it
            # must not claim to have hashed.
            if request.method != "GET" or response.status_code != 200:
                return response
            if not isinstance(response.body, bytes):
                return response

            tag = _fingerprint(response.body)
            response.headers["ETag"] = tag
            # This endpoint answers differently depending on who is asking —
            # your own drafts, and whether *you* voted. Without this, a shared
            # cache between the reader and the server is free to hand one
            # person's feed to the next.
            response.headers["Vary"] = "Authorization"

            # `If-None-Match` is a list, and `*` means "any". Both are in the
            # spec and both are cheap to honour; neither is something this app's
            # own client sends.
            presented = request.headers.get("if-none-match", "")
            offered = [v.strip() for v in presented.split(",") if v.strip()]
            if "*" in offered or tag in offered:
                # A 304 carries the validators and nothing else. Content-Length
                # in particular must go: it described a body that is no longer
                # being sent, and leaving it behind is how a client ends up
                # waiting for bytes that never arrive.
                headers = {
                    k: v
                    for k, v in response.headers.items()
                    if k.lower() not in ("content-length", "content-type")
                }
                return Response(status_code=304, headers=headers)

            return response

        return with_etag
