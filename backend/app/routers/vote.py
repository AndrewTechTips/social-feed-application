from fastapi import status, HTTPException, Depends, APIRouter
from sqlalchemy import select, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import schemas, database, models, oauth2

router = APIRouter(prefix="/vote", tags=["Vote"])


@router.post("/", status_code=status.HTTP_201_CREATED)
def vote(
    payload: schemas.Vote,
    db: Session = Depends(database.get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
):

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
