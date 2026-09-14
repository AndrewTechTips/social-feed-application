from typing import Any, Optional

from fastapi import status, HTTPException, Depends, APIRouter, Query, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..limiter import limiter
from .. import models, schemas, utils, oauth2
from .post import page_of_posts, visible_to

router = APIRouter(prefix="/users", tags=["Users"])


@router.post("/", status_code=status.HTTP_201_CREATED, response_model=schemas.UserOut)
@limiter.limit("10/hour")
def create_user(
    request: Request, user: schemas.UserCreate, db: Session = Depends(get_db)
) -> models.User:
    # Two columns can collide independently, and being told "that didn't work"
    # when only one of them is the problem is a miserable way to fill in a form.
    # So look first and name the one that clashed.
    taken = db.scalar(
        select(models.User).where(
            (models.User.username == user.username) | (models.User.email == user.email)
        )
    )
    if taken:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "That username is taken"
                if taken.username == user.username
                else "An account with this email already exists"
            ),
        )

    user.password = utils.hash_password(user.password)
    new_user = models.User(**user.model_dump())
    db.add(new_user)

    try:
        db.commit()
    except IntegrityError:
        # The check above is not a lock: two registrations racing each other
        # both find nothing and both insert. The UNIQUE constraints are what
        # actually settle it, and the loser lands here. Which column gave way
        # isn't worth digging out of the driver's error — it's a rare tie, and
        # the honest answer covers both.
        #
        # Worth knowing either way: this endpoint does tell a caller which
        # usernames and addresses are registered. For a username that's the
        # point — you can't pick one without knowing it's free. For the email
        # it's a real if minor leak; the usual fix is to answer 201 regardless
        # and send the "you already have an account" note by email, which needs
        # mail this project doesn't have. The 10/hour limit is the compensating
        # control.
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That username or email is already taken",
        )

    db.refresh(new_user)
    return new_user


# Declared before /{username}: FastAPI matches routes in definition order, so
# the other way round "me" would be looked up as somebody's name. (Registering
# it is blocked too — see schemas.RESERVED_USERNAMES — because relying on route
# ordering alone is one careless reshuffle away from a bug.)
@router.get("/me", response_model=schemas.MeOut)
def get_me(current_user: models.User = Depends(oauth2.get_current_user)) -> models.User:
    """Who the caller is.

    Logging in takes an email and a password and hands back a token, which
    tells the client nothing about the person it just signed in. That was
    survivable while posts carried their author's email and the client could
    match on it; now that the public identity is a username and the email never
    leaves this endpoint, something has to close the gap. Without it a browser
    with no local history can sign in successfully and still not know which
    posts are its own.
    """
    return current_user


@router.get("/{username}", response_model=schemas.UserOut)
def get_user(username: str, db: Session = Depends(get_db)) -> models.User:
    user = db.scalar(
        select(models.User).where(models.User.username == username.lower())
    )
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"There's nobody here called {username}",
        )
    return user


@router.get("/{username}/posts", response_model=schemas.PostPage)
def get_user_posts(
    username: str,
    db: Session = Depends(get_db),
    current_user: Optional[models.User] = Depends(oauth2.get_current_user_optional),
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
) -> dict[str, Any]:
    """Everything by one person — same page shape as the feed, same rules.

    Including the draft rule: their unpublished posts are theirs, so this shows
    them to the author and to nobody else.
    """
    author = db.scalar(
        select(models.User).where(models.User.username == username.lower())
    )
    if not author:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"There's nobody here called {username}",
        )

    return page_of_posts(
        db,
        filters=(models.Post.user_id == author.id, visible_to(current_user)),
        page=page,
        page_size=page_size,
    )
