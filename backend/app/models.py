from datetime import datetime

from sqlalchemy import Computed, ForeignKey, Index, func
from sqlalchemy.dialects.postgresql import TSVECTOR
from sqlalchemy.orm import query_expression, relationship, Mapped, mapped_column
from sqlalchemy.sql.expression import text
from sqlalchemy.types import TIMESTAMP

from .database import Base

# What the feed's search actually searches.
#
# Kept as a GENERATED ... STORED column rather than maintained by a trigger or
# by the application: the database computes it on every INSERT and UPDATE, so
# there is no way to write a row whose index disagrees with its text. A trigger
# would do the same job with more moving parts; doing it in Python would mean
# any other writer — a migration, psql, a future script — silently skips it.
#
# setweight is the whole reason this isn't one call to to_tsvector: a word in
# the title should count for more than the same word buried in the body, and
# 'A' vs 'B' is what ts_rank reads to make that true (1.0 against 0.4 with the
# default weights).
SEARCH_VECTOR_SQL = (
    "setweight(to_tsvector('english', coalesce(title, '')), 'A') || "
    "setweight(to_tsvector('english', coalesce(content, '')), 'B')"
)


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
        # GIN, not btree: a tsvector holds many lexemes per row and btree can
        # only index the value as a whole. This is the index that makes search
        # a lookup instead of a scan-and-stem of every post.
        Index("ix_posts_search_vector", "search_vector", postgresql_using="gin"),
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
    # Derived, never written. Declared here so create_all() and `alembic check`
    # both know about it; see SEARCH_VECTOR_SQL above for what's in it.
    search_vector: Mapped[str] = mapped_column(
        TSVECTOR, Computed(SEARCH_VECTOR_SQL, persisted=True), nullable=True
    )

    user: Mapped["User"] = relationship()

    # Not a column. The vote count is attached per query — page_of_posts()
    # selects it as an aggregate, _attach_votes() counts it for one row — and
    # PostOut reads it back through from_attributes.
    #
    # This used to be a bare `post.votes = n` onto an unmapped attribute, which
    # worked and was a trick: nothing declared it, so nothing could check it and
    # a reader had to find the assignment to learn the field existed.
    # query_expression() is SQLAlchemy's name for exactly this — an ORM
    # attribute with no column behind it — so the shape is declared in the one
    # place people look for it.
    votes: Mapped[int] = query_expression()


class User(Base):

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    # The public identity. Everything a stranger can see about a person is this
    # word — the email is a credential and never leaves the account it belongs
    # to. Stored lower-case (schemas.USERNAME_RE enforces it) so a plain unique
    # constraint is also a case-insensitive one, with no functional index and no
    # second normalised column to keep in step.
    username: Mapped[str] = mapped_column(unique=True)
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


class Comment(Base):
    __tablename__ = "comments"

    # One question gets asked of this table over and over: "the comments on
    # post N, oldest first". The composite index answers both halves of it,
    # so a busy post never costs a scan and a sort.
    # user_id gets its own because the foreign key is walked the other way
    # when an account goes: deleting a person deletes what they said.
    __table_args__ = (
        Index("ix_comments_post_id_created_at", "post_id", "created_at"),
        Index("ix_comments_user_id", "user_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    content: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )
    # Both cascades are declared at the database, not in the ORM, which is the
    # same arrangement votes have: a post that goes takes its comments with it
    # whoever issued the DELETE — a session, a migration, psql. A relationship
    # with cascade="all, delete-orphan" would only hold for rows this process
    # happened to have loaded.
    post_id: Mapped[int] = mapped_column(ForeignKey("posts.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))

    user: Mapped["User"] = relationship()
