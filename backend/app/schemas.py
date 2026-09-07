from datetime import datetime
from typing import Optional, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class PostBase(BaseModel):
    title: str
    content: str
    published: bool = True


class PostCreate(PostBase):
    pass


class UserOut(BaseModel):
    id: int
    email: EmailStr
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class PostUpdate(BaseModel):
    """Body for PATCH /posts/{id} — every field optional, only sent ones change."""

    title: Optional[str] = None
    content: Optional[str] = None
    published: Optional[bool] = None


class PostOut(PostBase):
    id: int
    created_at: datetime
    updated_at: datetime
    user_id: int
    user: UserOut
    votes: int = 0
    model_config = ConfigDict(from_attributes=True)


class PostPage(BaseModel):
    """A page of posts plus the metadata a UI needs to render pagination."""

    items: list[PostOut]
    total: int
    page: int
    page_size: int
    pages: int
    has_next: bool
    has_prev: bool


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)

    @field_validator("password")
    @classmethod
    def password_fits_bcrypt(cls, value: str) -> str:
        # bcrypt hashes at most 72 *bytes*; a longer value raises at hash time.
        # Field(max_length=...) counts characters, so we check bytes here to
        # also cover multibyte passwords (accented letters, emoji).
        if len(value.encode("utf-8")) > 72:
            raise ValueError("password must be at most 72 bytes long")
        return value


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str


class TokenData(BaseModel):
    id: Optional[int] = None


class Vote(BaseModel):
    post_id: int
    dir: Literal[0, 1]
