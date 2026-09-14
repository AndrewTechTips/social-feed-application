"""Comments on a post.

Two paths, because a comment is two things at once. Reading and writing them
is something you do *to a post*, so those live under ``/posts/{post_id}``;
deleting one is something you do to a comment you wrote, which has nothing to
do with which post it happens to sit on, so that one is addressed directly.

Everything here inherits the post's visibility rule. A draft belongs to its
author until they publish it, and that has to cover the conversation around it
too — otherwise "you can't read this" would still let you count the replies,
and a comment posted on an unpublished draft would be a message dropped into a
room nobody can enter.
"""

import math
from typing import Optional

from fastapi import status, HTTPException, Response, Depends, APIRouter, Query
from sqlalchemy import select, func
from sqlalchemy.orm import Session, selectinload

from .. import models, schemas, oauth2
from ..database import get_db
from .post import visible_to

router = APIRouter(tags=["Comments"])


def get_owned_comment(
    id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
) -> models.Comment:
    """Load a comment by id (404 if missing) and check the caller wrote it
    (403 if not). The same shape as ``get_owned_post``, for the same reason:
    the rule is worth exactly one copy, and a second resource is where a
    pattern either earns its keep or turns out to have been a coincidence."""
    comment = db.scalar(select(models.Comment).where(models.Comment.id == id))
    if comment is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Comment with id: {id} does not exist",
        )
    if comment.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not authorized to perform requested action",
        )
    return comment


def get_visible_post(
    db: Session, post_id: int, viewer: Optional[models.User]
) -> models.Post:
    """The post these comments belong to, as this caller is allowed to see it.

    Reported as missing rather than forbidden when they aren't, which is the
    same answer ``GET /posts/{id}`` gives and for the same reason: a 403 would
    confirm the draft exists.
    """
    post = db.scalar(
        select(models.Post).where(models.Post.id == post_id, visible_to(viewer))
    )
    if post is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Post with id: {post_id} was not found",
        )
    return post


@router.get("/posts/{post_id}/comments", response_model=schemas.CommentPage)
def get_comments(
    post_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[models.User] = Depends(oauth2.get_current_user_optional),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
):
    """One page of a post's comments, **oldest first**.

    The feed runs newest-first because you arrive at it to see what's new. A
    comment thread is read top to bottom like a conversation, so it runs the
    other way — and the page size is larger, because twenty short lines is
    about one screen where ten posts is several.
    """
    get_visible_post(db, post_id, current_user)

    total = db.scalar(
        select(func.count())
        .select_from(models.Comment)
        .where(models.Comment.post_id == post_id)
    )

    items = db.scalars(
        select(models.Comment)
        .options(selectinload(models.Comment.user))
        .where(models.Comment.post_id == post_id)
        .order_by(models.Comment.created_at, models.Comment.id)
        .limit(page_size)
        .offset((page - 1) * page_size)
    ).all()

    pages = math.ceil(total / page_size) if total else 0
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": pages,
        "has_next": page < pages,
        "has_prev": page > 1,
    }


@router.post(
    "/posts/{post_id}/comments",
    status_code=status.HTTP_201_CREATED,
    response_model=schemas.CommentOut,
)
def create_comment(
    post_id: int,
    payload: schemas.CommentCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
):
    get_visible_post(db, post_id, current_user)

    comment = models.Comment(
        post_id=post_id, user_id=current_user.id, content=payload.content
    )
    db.add(comment)
    db.commit()
    db.refresh(comment)
    return comment


@router.delete("/comments/{id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_comment(
    comment: models.Comment = Depends(get_owned_comment),
    db: Session = Depends(get_db),
):
    """Yours to remove, and nobody else's.

    Note what this deliberately isn't: the author of the *post* can't delete
    comments on it. Moderation is a feature with a scope of its own — who may
    remove what, whether the person who wrote it is told, whether it leaves a
    tombstone — and quietly granting it to post authors here would be a policy
    decision smuggled in as an ownership check.
    """
    db.delete(comment)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
