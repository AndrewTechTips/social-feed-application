"""Somebody addressed you.

Two routes. One lists what has been said to you; the other says you have seen
it. There is deliberately no third: the unread *count* is asked for through the
list, with `?unread=true&page_size=1`, and read off the envelope's `total` —
the same trick the "new posts" pill plays against `/posts/?since=`. One
endpoint, one shape to keep in step across three implementations, and a poll
that costs one row.

What creates the rows is not here. It is in `routers/comment.py`, beside the
comment that caused it, because a notification is a consequence of something
happening rather than a thing anybody asks for. See `notify()` below, which is
the one function both halves share.
"""

import math
from datetime import datetime, UTC
from typing import Optional

from fastapi import status, Depends, APIRouter, Query
from sqlalchemy import select, func, update
from sqlalchemy.orm import Session, selectinload

from .. import models, schemas, oauth2, docs
from ..database import get_db

router = APIRouter(prefix="/notifications", tags=["Notifications"])

# How much of what they said comes back in the list.
#
# Long enough to tell whether it is worth opening — which is the whole job of
# the line — and short enough that one notification is one or two lines on a
# phone. A 2,000-character reply rendered in full would make a list of five
# taller than the screen.
EXCERPT_CHARS = 140


def notify(
    db: Session, *, comment: models.Comment, post: models.Post, actor: models.User
) -> Optional[models.Notification]:
    """Record that this comment addressed somebody, if it addressed anybody.

    One comment, at most one notification, and the two rules do not overlap:

      · a **reply** addresses the person it answers;
      · a **top-level comment** addresses the post's author.

    A reply on your own post therefore notifies whoever was replied to, and not
    you as well. The alternative — everybody with a stake in a thread hears
    about everything in it — is how a notification list becomes a thing people
    turn off.

    Talking to yourself is not an event. Replying to your own comment, or
    commenting on your own post, produces nothing, which is why this returns
    `Optional` rather than always handing back a row.

    Added to the session but **not committed**: the caller is in the middle of
    writing the comment this is about, and the two belong in one transaction.
    A notification that survived a failed comment would point at nothing.
    """
    if comment.parent_id is not None:
        parent = db.get(models.Comment, comment.parent_id)
        # The parent was checked by the caller, so this is belt and braces —
        # but a notification is a write, and a write built on an assumption is
        # a row pointing at nothing the first time the assumption is wrong.
        if parent is None:
            return None
        recipient_id = parent.user_id
        kind = schemas.NotificationKind.reply
    else:
        recipient_id = post.user_id
        kind = schemas.NotificationKind.comment

    if recipient_id == actor.id:
        return None

    row = models.Notification(
        user_id=recipient_id,
        actor_id=actor.id,
        comment_id=comment.id,
        kind=kind.value,
    )
    db.add(row)
    return row


@router.get(
    "/",
    response_model=schemas.NotificationPage,
    summary="What has been said to you",
    responses={
        200: docs.ok(docs.page(docs.NOTIFICATION_EXAMPLE, total=4)),
        **docs.errors(401, 422),
    },
)
def list_notifications(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=50),
    unread: bool = Query(
        False,
        description=(
            "Only the ones you haven't seen. With `page_size=1` this is also "
            "how you ask for the unread *count*: the answer is the envelope's "
            "`total`."
        ),
    ),
) -> schemas.NotificationPage:
    """Newest first, because a notification is about what just happened.

    Yours only, and that is not a filter a caller can lift: the `user_id`
    predicate is applied here and there is no parameter that changes it.
    """
    filters = [models.Notification.user_id == current_user.id]
    if unread:
        filters.append(models.Notification.read_at.is_(None))

    total = (
        db.scalar(select(func.count()).select_from(models.Notification).where(*filters))
        or 0
    )
    pages = max(1, math.ceil(total / page_size))

    rows = (
        db.scalars(
            select(models.Notification)
            .where(*filters)
            # The actor and the comment are drawn on every row, and the
            # comment's post supplies the title — three selectinloads rather
            # than three queries per notification.
            .options(
                selectinload(models.Notification.actor),
                selectinload(models.Notification.comment).selectinload(
                    models.Comment.post
                ),
            )
            .order_by(
                models.Notification.created_at.desc(), models.Notification.id.desc()
            )
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .unique()
        .all()
    )

    items = [
        schemas.NotificationOut(
            id=row.id,
            kind=schemas.NotificationKind(row.kind),
            created_at=row.created_at,
            read_at=row.read_at,
            actor=schemas.UserOut.model_validate(row.actor, from_attributes=True),
            post=schemas.NotificationPost(
                id=row.comment.post.id, title=row.comment.post.title
            ),
            excerpt=_excerpt(row.comment.content),
            comment_id=row.comment_id,
        )
        for row in rows
    ]

    return schemas.NotificationPage(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        pages=pages,
        has_next=page < pages,
        has_prev=page > 1,
    )


def _excerpt(content: str) -> str:
    """The first sentence or so of what they said.

    Cut on a word boundary and marked with an ellipsis, because a line that
    stops mid-word reads as broken rather than as abbreviated. The character
    the client draws is the one sent: there is no markup here and no client-side
    truncation to disagree with.
    """
    text = " ".join(content.split())
    if len(text) <= EXCERPT_CHARS:
        return text
    cut = text[:EXCERPT_CHARS].rsplit(" ", 1)[0]
    return f"{cut or text[:EXCERPT_CHARS]}…"


@router.post(
    "/read",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Mark everything as seen",
    responses={
        204: {"description": "Seen. Answered whether or not there was anything."},
        **docs.errors(401),
    },
)
def mark_all_read(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
) -> None:
    """Mark every unread notification of yours as seen.

    All of them, rather than the ones a client happens to have drawn. The badge
    exists to say "there is something new", and a badge that goes on saying so
    after you have looked is a badge people stop believing.

    One UPDATE, not a read-then-write loop: the rows are not wanted back.
    """
    db.execute(
        update(models.Notification)
        .where(
            models.Notification.user_id == current_user.id,
            models.Notification.read_at.is_(None),
        )
        .values(read_at=datetime.now(UTC))
    )
    db.commit()
