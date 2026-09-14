import re
from datetime import datetime
from typing import Optional, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

# The username rule, in one place because three things enforce it: this module,
# the register form in frontend/js/views/auth.js, and the two stand-in backends
# the end-to-end suite runs against.
#
#   · 3–20 characters
#   · letters, digits, underscore, hyphen
#   · must start with a letter — so a username can never be mistaken for an id
#     in a URL, and "123" can't become a person
#   · folded to lower case, which is what makes the plain UNIQUE constraint on
#     the column a case-insensitive one as well
USERNAME_RE = re.compile(r"^[a-z][a-z0-9_-]{2,19}$")
USERNAME_RULE = "3–20 characters: letters, digits, - and _, starting with a letter"

# Names the API needs for itself. Without this, registering "me" would shadow
# GET /users/me for everyone.
RESERVED_USERNAMES = frozenset({"me", "admin", "api", "root", "commons"})


class PostBase(BaseModel):
    title: str
    content: str
    published: bool = True


class PostCreate(PostBase):
    pass


class UserOut(BaseModel):
    """A person, as everybody else sees them. No email: that's a credential,
    and handing it to anyone who can walk a list of ids is how address books
    get scraped."""

    id: int
    username: str
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)


class MeOut(UserOut):
    """A person, as they see themselves. Same shape plus the email, because on
    this one endpoint the caller is the only person it belongs to."""

    email: EmailStr


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


# A comment is one short thing said in response to a post. Long enough for a
# paragraph or two, short enough that nobody writes an essay in the margin of
# somebody else's — and, unlike a post, capped at the API rather than only in
# the form, because this is the field a script would point at first.
COMMENT_MAX = 2000


class CommentCreate(BaseModel):
    content: str

    @field_validator("content")
    @classmethod
    def content_has_something_in_it(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("a comment needs something in it")
        if len(trimmed) > COMMENT_MAX:
            raise ValueError(f"a comment can be at most {COMMENT_MAX} characters")
        return trimmed


class CommentOut(BaseModel):
    id: int
    content: str
    created_at: datetime
    post_id: int
    user_id: int
    user: UserOut
    model_config = ConfigDict(from_attributes=True)


class CommentPage(BaseModel):
    """A page of comments. Deliberately the same shape as ``PostPage`` — a
    client that can page through one can page through the other without
    learning a second set of field names."""

    items: list[CommentOut]
    total: int
    page: int
    page_size: int
    pages: int
    has_next: bool
    has_prev: bool


class UserCreate(BaseModel):
    username: str
    email: EmailStr
    password: str = Field(min_length=8)

    @field_validator("username")
    @classmethod
    def username_is_usable(cls, value: str) -> str:
        folded = value.strip().lower()
        if not USERNAME_RE.match(folded):
            raise ValueError(USERNAME_RULE)
        if folded in RESERVED_USERNAMES:
            raise ValueError("that username is reserved")
        return folded

    @field_validator("password")
    @classmethod
    def password_fits_bcrypt(cls, value: str) -> str:
        # bcrypt hashes at most 72 *bytes*; a longer value raises at hash time.
        # Field(max_length=...) counts characters, so we check bytes here to
        # also cover multibyte passwords (accented letters, emoji).
        if len(value.encode("utf-8")) > 72:
            raise ValueError("password must be at most 72 bytes long")
        return value


class Token(BaseModel):
    access_token: str
    token_type: str


class TokenData(BaseModel):
    id: Optional[int] = None


class Vote(BaseModel):
    post_id: int
    dir: Literal[0, 1]
