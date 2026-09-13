import math
from typing import Optional

from fastapi import status, HTTPException, Response, Depends, APIRouter, Query
from sqlalchemy import select, func, or_
from sqlalchemy.orm import Session, selectinload

from .. import models, schemas, oauth2
from ..database import get_db

router = APIRouter(prefix="/posts", tags=["Posts"])


def _attach_votes(db: Session, post: models.Post) -> models.Post:
    """Count votes for one post and stash the number on a transient attribute
    so the ``PostOut`` schema (from_attributes) can read ``post.votes``."""
    post.votes = (
        db.scalar(
            select(func.count(models.Vote.post_id)).where(
                models.Vote.post_id == post.id
            )
        )
        or 0
    )
    return post


def get_owned_post(
    id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
) -> models.Post:
    """Load a post by id (404 if missing) and check the caller owns it
    (403 if not). Shared by delete / put / patch so that rule lives in one
    place instead of being copy-pasted."""
    post = db.scalar(select(models.Post).where(models.Post.id == id))
    if post is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Post with id: {id} does not exist",
        )
    if post.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not authorized to perform requested action",
        )
    return post


def _visible_to(user: Optional[models.User]):
    """Rows the caller is allowed to see: everything published, plus your own
    drafts. ``published`` is a real access rule, not a display hint — an
    unpublished post belongs to its author until they say otherwise."""
    if user is None:
        return models.Post.published.is_(True)
    return or_(models.Post.published.is_(True), models.Post.user_id == user.id)


@router.get("/", response_model=schemas.PostPage)
def get_posts(
    db: Session = Depends(get_db),
    current_user: Optional[models.User] = Depends(oauth2.get_current_user_optional),
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
    search: Optional[str] = Query("", max_length=100),
):
    # autoescape: without it a `%` or `_` typed into the search box is a live
    # LIKE wildcard rather than the character the person typed.
    search_filter = models.Post.title.contains(search, autoescape=True)
    visible = _visible_to(current_user)
    offset = (page - 1) * page_size

    total = db.scalar(
        select(func.count()).select_from(models.Post).where(search_filter, visible)
    )

    stmt = (
        select(models.Post, func.count(models.Vote.post_id).label("votes"))
        .join(models.Vote, models.Vote.post_id == models.Post.id, isouter=True)
        .options(selectinload(models.Post.user))
        .where(search_filter, visible)
        .group_by(models.Post.id)
        .order_by(models.Post.created_at.desc())
        .limit(page_size)
        .offset(offset)
    )

    items = []
    for post, votes in db.execute(stmt).all():
        post.votes = votes
        items.append(post)

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


@router.post("/", status_code=status.HTTP_201_CREATED, response_model=schemas.PostOut)
def create_posts(
    post: schemas.PostCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
):
    new_post = models.Post(user_id=current_user.id, **post.model_dump())
    db.add(new_post)
    db.commit()
    db.refresh(new_post)
    new_post.votes = 0  # a brand new post has no votes
    return new_post


@router.get("/{id}", response_model=schemas.PostOut)
def get_post(
    id: int,
    db: Session = Depends(get_db),
    current_user: Optional[models.User] = Depends(oauth2.get_current_user_optional),
):
    post = db.scalar(
        select(models.Post)
        .options(selectinload(models.Post.user))
        .where(models.Post.id == id, _visible_to(current_user))
    )
    if post is None:
        # Someone else's draft is reported as missing, not as forbidden: a 403
        # would confirm that a post with this id exists, which is the thing the
        # author hasn't published yet.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Post with id: {id} was not found",
        )
    return _attach_votes(db, post)


@router.delete("/{id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_post(
    post: models.Post = Depends(get_owned_post),
    db: Session = Depends(get_db),
):
    db.delete(post)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/{id}", response_model=schemas.PostOut)
def update_post(
    updated_post: schemas.PostCreate,
    post: models.Post = Depends(get_owned_post),
    db: Session = Depends(get_db),
):
    # PUT = full replacement: every field of PostCreate is applied.
    for key, value in updated_post.model_dump().items():
        setattr(post, key, value)
    db.commit()
    db.refresh(post)
    return _attach_votes(db, post)


@router.patch("/{id}", response_model=schemas.PostOut)
def patch_post(
    payload: schemas.PostUpdate,
    post: models.Post = Depends(get_owned_post),
    db: Session = Depends(get_db),
):
    # PATCH = partial update: only the fields the client actually sent.
    data = payload.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields provided to update",
        )
    for key, value in data.items():
        setattr(post, key, value)
    db.commit()
    db.refresh(post)
    return _attach_votes(db, post)
