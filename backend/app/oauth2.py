from datetime import datetime, timedelta, UTC

import jwt
from fastapi import Depends, Request, status, HTTPException
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import schemas
from . import database, models
from .config import settings

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")

SECRET_KEY = settings.secret_key
ALGORITHM = settings.algorithm
ACCESS_TOKEN_EXPIRE_MINUTES = settings.access_token_expire_minutes


def create_access_token(data: dict[str, object]) -> str:
    to_encode = data.copy()
    expire = datetime.now(UTC) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})

    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def verify_access_token(
    token: str, credentials_exception: HTTPException
) -> schemas.TokenData:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])

        user_id: int | None = payload.get("user_id")
        if user_id is None:
            raise credentials_exception

        token_data = schemas.TokenData(id=user_id)

    except jwt.InvalidTokenError:
        raise credentials_exception

    return token_data


def get_current_user(
    token: str = Depends(oauth2_scheme), db: Session = Depends(database.get_db)
) -> models.User:

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    token_data = verify_access_token(token, credentials_exception)
    stmt = select(models.User).where(models.User.id == token_data.id)
    user = db.scalar(stmt)

    if user is None:
        raise credentials_exception

    return user


def get_current_user_optional(
    request: Request, db: Session = Depends(database.get_db)
) -> models.User | None:
    """Like ``get_current_user``, but for routes that are public *and* show a
    little more to a signed-in caller (the feed shows you your own drafts).

    A missing or unusable token is not an error here — it just means "anonymous".
    We read the header by hand rather than reusing ``oauth2_scheme`` because
    OAuth2PasswordBearer raises a 401 when the header is absent, which is exactly
    what this dependency must not do.
    """
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.InvalidTokenError:
        return None

    user_id = payload.get("user_id")
    if user_id is None:
        return None

    return db.scalar(select(models.User).where(models.User.id == user_id))
