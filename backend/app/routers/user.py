from typing import Any, Optional

from fastapi import (
    status,
    HTTPException,
    Depends,
    APIRouter,
    Query,
    Request,
    Response,
)
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..limiter import limiter
from .. import models, schemas, utils, oauth2, docs
from .post import page_of_posts, visible_to

router = APIRouter(prefix="/users", tags=["Users"])


@router.post(
    "/",
    status_code=status.HTTP_201_CREATED,
    response_model=schemas.UserOut,
    summary="Create an account",
    responses={
        201: docs.ok(docs.USER_EXAMPLE),
        409: {
            "model": schemas.Detail,
            "description": (
                "The username or the email is already registered. The message "
                "names which — for a username that's unavoidable, since you "
                "can't pick one without knowing it's free."
            ),
        },
        **docs.errors(422, 429),
    },
)
@limiter.limit("10/hour")
def create_user(
    request: Request, user: schemas.UserCreate, db: Session = Depends(get_db)
) -> models.User:
    """Register.

    The username is folded to lower case and must match
    `^[a-z][a-z0-9_-]{2,19}$` — starting with a letter, so a username can never
    be mistaken for an id in a URL. A handful of names the API needs for itself
    (`me`, `admin`, `api`, `root`, `commons`) are refused.

    The response is a `UserOut` and carries no email. Registering does not sign
    you in: `POST /login` does that.
    """
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
@router.get(
    "/me",
    response_model=schemas.MeOut,
    summary="Who the caller is",
    responses={200: docs.ok(docs.ME_EXAMPLE), **docs.errors(401)},
)
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


@router.patch(
    "/me",
    response_model=schemas.MeOut,
    summary="Change your username",
    responses={
        200: docs.ok(docs.ME_EXAMPLE),
        **docs.errors(401, 409, 422),
    },
)
def update_me(
    payload: schemas.MeUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
) -> models.User:
    """Change the name everybody else sees.

    Only the username. The email and the password are the credential half of an
    account and changing either is a flow with a confirmation in it, not a text
    box on a settings screen.

    A name that is taken is a 409 with a sentence, the same answer registering
    gives — and for the same reason it is caught from the database rather than
    checked first: two people asking for the same free name in the same moment
    both pass a lookup and one of them still has to lose.

    Nothing else moves. Posts, comments and votes are joined by id, and the id
    is the half of an identity that was always meant to be the durable one.
    """
    if payload.username == current_user.username:
        return current_user

    current_user.username = payload.username
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That username is taken",
        )
    db.refresh(current_user)
    return current_user


@router.delete(
    "/me",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete your account",
    responses={
        204: {"description": "Gone, along with everything you wrote."},
        **docs.errors(401),
    },
)
def delete_me(
    response: Response,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(oauth2.get_current_user),
) -> None:
    """Delete your account and everything attached to it.

    Everything means everything: posts, the comments on them, the comments you
    left elsewhere, your votes, and every session you have open. None of that
    is spelled out here — each one is an `ON DELETE CASCADE` declared on the
    column that points at you, so it holds whoever issues the DELETE and cannot
    drift from what this function happens to remember to clean up.

    The refresh cookie is cleared on the way out. It names a session row that
    no longer exists, so the browser would recover on its own the next time it
    tried; leaving somebody holding a credential for an account that is gone is
    nevertheless not a tidy way to say goodbye.
    """
    db.delete(current_user)
    db.commit()
    oauth2.clear_refresh_cookie(response)


@router.get(
    "/{username}",
    response_model=schemas.UserOut,
    summary="A public profile",
    responses={200: docs.ok(docs.USER_EXAMPLE), **docs.errors(404)},
)
def get_user(username: str, db: Session = Depends(get_db)) -> models.User:
    """One person, by username. Case-insensitive, because names are stored
    folded and nobody types their own capitals the same way twice."""
    user = db.scalar(
        select(models.User).where(models.User.username == username.lower())
    )
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"There's nobody here called {username}",
        )
    return user


@router.get(
    "/{username}/posts",
    response_model=schemas.PostPage,
    summary="Everything by one person",
    responses={
        200: docs.ok(docs.page(docs.POST_EXAMPLE, total=3)),
        **docs.errors(404, 422),
    },
)
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
        viewer=current_user,
    )
