"""The shelf — posts somebody saved to read later.

Two path shapes, on the same principle the comment router follows: saving is
something you do *to a post*, so it lives under ``/posts/{id}``; the shelf
itself is a thing of yours, so it is addressed directly.

**Saving is idempotent, and that is the whole reason these are PUT and DELETE
rather than a POST that toggles.** A shelf is a set. Asking for a post to be on
it twice is not an error, it is the state you already asked for — so PUT
answers 204 whether or not it was there a moment ago, and DELETE does the same.
That matters more than it sounds: the control in the UI is a toggle next to a
card, it is pressed twice by accident all the time, and a version of this that
answered 409 on the second press would need the client to treat one of its own
errors as success. Voting had to do exactly that, and it is the one piece of
that API a client has to be told about.

The shelf inherits the feed's visibility rule through ``page_of_posts``, which
matters for one case that is easy to miss: you can save your own draft, and you
should be able to — but if it were ever *un*published after somebody else saved
it, it has to leave their shelf. Filtering on read rather than cleaning up on
write is what makes that true without a single trigger.
"""

import math
from typing import Any

from fastapi import status, Depends, APIRouter, Query, Request, Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import models, schemas, oauth2, docs
from ..database import get_db
from ..limiter import limiter, SHELVE
from .post import get_visible_post, page_of_posts, visible_to

router = APIRouter(tags=["Shelf"])


@router.put(
    "/posts/{id}/save",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Put a post on your shelf",
    responses={
        204: {
            "description": (
                "On your shelf. Saying so again is the same answer — this is a "
                "set, and asking for a post to be in it twice is not an error."
            )
        },
        **docs.errors(401, 404),
    },
)
@limiter.limit(SHELVE)
def save_post(
    request: Request,
    id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
) -> Response:
    """Save a post you can see.

    A draft you don't own answers 404, exactly as reading it would — a 403
    would confirm that it exists.
    """
    post = get_visible_post(db, id, current_user)

    db.add(models.Save(user_id=current_user.id, post_id=post.id))
    try:
        db.commit()
    except IntegrityError:
        # Two presses racing each other. The composite primary key settles it,
        # and the loser wanted the state the winner just produced — so this is
        # success, not a conflict. Same reasoning as the idempotence above; the
        # difference is that this one is decided by the database rather than by
        # a check that could be stale by the time it is read.
        db.rollback()

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/posts/{id}/save",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Take a post off your shelf",
    responses={
        204: {
            "description": (
                "Off your shelf — including when it was never on it. The state "
                "you asked for is the state you're in."
            )
        },
        **docs.errors(401),
    },
)
@limiter.limit(SHELVE)
def unsave_post(
    request: Request,
    id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
) -> Response:
    """Remove a post from your shelf.

    No 404 on this one, deliberately, and not for symmetry: there is nothing
    here worth reporting as missing. Whether the post exists, whether you could
    see it, and whether you had saved it all end in the same place — it is not
    on your shelf — and three ways of saying that would be three branches a
    client has to handle to reach one outcome.
    """
    save = db.get(models.Save, {"user_id": current_user.id, "post_id": id})
    if save is not None:
        db.delete(save)
        db.commit()

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/shelf",
    response_model=schemas.PostPage,
    summary="What you saved",
    responses={
        200: docs.ok(docs.page({**docs.POST_EXAMPLE, "saved": True}, total=6)),
        **docs.errors(401, 422),
    },
)
def get_shelf(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
) -> dict[str, Any]:
    """Your shelf, most recently saved first.

    Ordered by when you saved it rather than by when it was written, which is
    the difference between a shelf and a feed: what you put there last is what
    you meant to read next. `ix_saves_user_id_created_at` hands that ordering
    back without a sort.

    It is one page of the feed's own machinery, so the visibility rule, the
    vote counts and `voted` are all the same here as anywhere else.
    """
    # Two queries, and the split is the point.
    #
    # The *order and the page* are a question about saves: what did I put here,
    # and when. The *contents* are a question about posts: who wrote it, how
    # many votes, have I voted. Asking the first one first means the page
    # boundary is drawn in shelf order, which is the only order this screen
    # has — paginating by the feed's ordering and then re-sorting each page
    # would give a list that is locally right and globally nonsense.
    #
    # The join to posts is not decoration: it applies the visibility rule to
    # the *count* as well as to the rows. A draft that somebody saved and its
    # author later unpublished leaves their shelf on read, so nothing has to
    # clean up after it on write.
    shelved = (
        select(models.Save.post_id)
        .join(models.Post, models.Post.id == models.Save.post_id)
        .where(models.Save.user_id == current_user.id, visible_to(current_user))
    )

    total = db.scalar(select(func.count()).select_from(shelved.subquery())) or 0
    pages = math.ceil(total / page_size) if total else 0

    page_ids = list(
        db.scalars(
            shelved.order_by(models.Save.created_at.desc())
            .limit(page_size)
            .offset((page - 1) * page_size)
        )
    )

    envelope: dict[str, Any] = {
        "items": [],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": pages,
        "has_next": page < pages,
        "has_prev": page > 1,
    }

    if not page_ids:
        return envelope

    # One page, hydrated by the feed's own machinery so that a card on the
    # shelf and the same card in the feed can never disagree about anything.
    hydrated = page_of_posts(
        db,
        filters=(models.Post.id.in_(page_ids),),
        page=1,
        page_size=len(page_ids),
        viewer=current_user,
    )

    # page_of_posts ordered these by when they were written. Put them back in
    # the order they were shelved — `page_ids` already holds it, and this is at
    # most one page of rows.
    position = {post_id: index for index, post_id in enumerate(page_ids)}
    envelope["items"] = sorted(hydrated["items"], key=lambda post: position[post.id])
    return envelope
