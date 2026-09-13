from datetime import datetime

from sqlalchemy import ForeignKey, Index, func
from sqlalchemy.orm import relationship, Mapped, mapped_column
from sqlalchemy.sql.expression import text
from sqlalchemy.types import TIMESTAMP

from .database import Base


class Post(Base):
    __tablename__ = "posts"

    # The feed is the only hot query here: filter on published, sort by
    # created_at, take ten. One composite index serves both halves, so the
    # planner never sorts the whole table to find the newest page.
    # Plain ascending on purpose — Postgres reads a btree backwards just as
    # happily, and DESC in the definition would only matter if this were part
    # of a mixed-direction sort.
    __table_args__ = (
        Index("ix_posts_published_created_at", "published", "created_at"),
        Index("ix_posts_user_id", "user_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str]  # Automatically deducted (VARCHAR, nullable=False)
    content: Mapped[str]
    published: Mapped[bool] = mapped_column(server_default="TRUE")
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()"), onupdate=func.now()
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))

    user: Mapped["User"] = relationship()


class User(Base):

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(unique=True)
    password: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )


class Vote(Base):
    __tablename__ = "votes"

    # The primary key is (user_id, post_id), which answers "has this person
    # voted on that post". The feed asks the opposite question — "how many
    # votes does this post have" — and a composite index led by user_id is no
    # use for it, so post_id gets its own.
    __table_args__ = (Index("ix_votes_post_id", "post_id"),)

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    post_id: Mapped[int] = mapped_column(
        ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True
    )
