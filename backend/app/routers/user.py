from fastapi import status, HTTPException, Depends, APIRouter, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from ..database import get_db
from ..limiter import limiter
from .. import models, schemas, utils

router = APIRouter(prefix="/users", tags=["Users"])


@router.post("/", status_code=status.HTTP_201_CREATED, response_model=schemas.UserOut)
@limiter.limit("10/hour")
def create_user(
    request: Request, user: schemas.UserCreate, db: Session = Depends(get_db)
):

    user.password = utils.hash_password(user.password)

    new_user = models.User(**user.model_dump())
    db.add(new_user)
    try:
        db.commit()
    except IntegrityError:
        # email column is UNIQUE — a second signup with the same address lands here.
        #
        # This does tell a caller which addresses are registered. The usual fix
        # is to answer 201 either way and send the "you already have an account"
        # message by email, which needs mail this project doesn't have. The
        # 10/hour limit above is the compensating control; revisit if email
        # delivery ever lands.
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists",
        )
    db.refresh(new_user)

    return new_user


@router.get("/{id}", response_model=schemas.UserOut)
def get_user(id: int, db: Session = Depends(get_db)):

    stmt = select(models.User).where(models.User.id == id)
    user = db.scalar(stmt)

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User with id: {id} does not exist",
        )

    return user
