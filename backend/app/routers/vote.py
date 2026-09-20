from fastapi import status, HTTPException, Request, Depends, APIRouter
from sqlalchemy import select, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import schemas, database, models, oauth2, docs
from ..limiter import limiter, VOTE

router = APIRouter(prefix="/vote", tags=["Vote"])


@router.post(
    "/",
    status_code=status.HTTP_201_CREATED,
    summary="Upvote a post, or take it back",
    responses={
        201: docs.ok(
            {"message": "Successfully added vote"},
            "Recorded. `dir: 0` answers 201 too, with " "`successfully deleted vote`.",
        ),
        404: {
            "model": schemas.Detail,
            "description": (
                "No such post — or, with `dir: 0`, no vote of yours to remove. "
                "A client rolling back an optimistic upvote can treat this as "
                "success: it means you are already in the state you asked for."
            ),
        },
        409: {
            "model": schemas.Detail,
            "description": (
                "You have already voted on this post. Same advice as the 404: "
                "the state you asked for is the state you're in."
            ),
        },
        **docs.errors(401, 422),
    },
)
@limiter.limit(VOTE)
def vote(
    request: Request,
    payload: schemas.Vote,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
) -> dict[str, str]:
    """Add or remove your upvote.

    One vote per person per post, enforced by the composite primary key on
    `votes` rather than by the check below — which is what makes two requests
    racing each other a 409 instead of a 500.

    You can't vote on a draft you aren't allowed to see, and that is reported
    as missing rather than forbidden, exactly as reading it would be.
    """

    # Same visibility rule as the feed: you can't vote on a draft you aren't
    # allowed to see, and it's reported as missing rather than forbidden.
    stmt_post = select(models.Post).where(
        models.Post.id == payload.post_id,
        or_(
            models.Post.published.is_(True),
            models.Post.user_id == current_user.id,
        ),
    )
    post = db.scalar(stmt_post)

    if not post:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Post with id: {payload.post_id} does not exist",
        )

    stmt_vote = select(models.Vote).where(
        models.Vote.post_id == payload.post_id,
        models.Vote.user_id == current_user.id,
    )
    found_vote = db.scalar(stmt_vote)

    if payload.dir == 1:
        if found_vote:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"User {current_user.id} has already voted on post {payload.post_id}",
            )
        new_vote = models.Vote(post_id=payload.post_id, user_id=current_user.id)
        db.add(new_vote)
        try:
            db.commit()
        except IntegrityError:
            # Two concurrent requests can both pass the check above; the
            # composite primary key is what actually settles it. Report the
            # loser of that race the same way as a plain duplicate.
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"User {current_user.id} has already voted on post {payload.post_id}",
            )
        return {"message": "Successfully added vote"}
    else:
        if not found_vote:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Vote does not exist"
            )
        db.delete(found_vote)
        db.commit()
        return {"message": "successfully deleted vote"}
