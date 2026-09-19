from datetime import datetime

from sqlalchemy import Computed, ForeignKey, Index, String, func
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

    # Whether *the person asking* has voted on this one. Declared the same way
    # and for the same reason as ``votes`` above: it is attached per query,
    # because it is not a property of the post at all — it is a property of the
    # pair (post, reader), and the same row answers differently for two people.
    #
    # It exists because the client used to guess. The API had no way to say
    # "you voted on this", so the frontend kept a set of post ids in
    # localStorage and hoped — which meant your own votes were invisible on a
    # second device, invisible in a private window, and wrong after clearing
    # site data. Answering the question is a left join; guessing at it was a
    # documented compromise sitting in two files.
    voted: Mapped[bool] = query_expression()

    # The sentence a search matched on, with the matching words marked. Only
    # ever attached when somebody searched — see ts_headline in routers/post.py
    # — because it is an answer to a question, and without a question there is
    # nothing to answer.
    excerpt: Mapped[str | None] = query_expression()


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


class RefreshSession(Base):
    """One browser's long-lived sign-in, so that the access token doesn't have
    to be one.

    Why there is a table here at all, when a self-contained refresh JWT would
    have needed none: a stateless refresh token cannot be taken back. Signing
    out would clear the cookie on the machine doing the signing out and leave
    the token itself valid everywhere else for a fortnight. Revocation is most
    of the point of splitting the two tokens in the first place, and revocation
    needs somewhere to write "not any more".

    What's stored is a SHA-256 of the secret, never the secret. The rows are
    read by exact hash lookup rather than compared one by one, so there is no
    timing signal to defend against and no reason for the cost of bcrypt; and
    a dump of this table still gets nobody in.

    ``id`` is the *family* id and survives rotation — every refresh mints a new
    secret into the same row. That's what makes reuse detectable: a second
    presentation of an already-rotated secret arrives with a family id that
    exists and a hash that doesn't match, which can only mean the cookie was
    copied. See ``oauth2.rotate_refresh_session``.
    """

    __tablename__ = "refresh_sessions"

    # Signing out everywhere, and cleaning up after an account, both walk this
    # the same way: give me every session belonging to this person.
    __table_args__ = (Index("ix_refresh_sessions_user_id", "user_id"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    # SHA-256 hex of the current secret, replaced on every rotation.
    token_hash: Mapped[str] = mapped_column(String(64))
    # The one it replaced, and when. Two tabs reloading together both send the
    # cookie the jar held a moment ago, and without a short grace window the
    # second one looks exactly like a replay — so a perfectly ordinary Tuesday
    # would revoke the session. See oauth2.ROTATION_GRACE.
    previous_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    rotated_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )
    # The CSRF token, in the clear, and issued once for the life of the session.
    #
    # Both of those are deliberate. It is stored readable because it is not a
    # credential: on its own it opens nothing, and its whole job is to prove
    # that whoever sent a request to /auth could read one of our responses —
    # which a cross-site page cannot. So it has to be handed back on every
    # refresh, and a hash can't be handed back.
    #
    # And it doesn't rotate, because rotating it would race. Two tabs sharing
    # one browser share the cookie jar but each carry their own copy of this;
    # rotate it and the tab whose response lands second overwrites the stored
    # value with one the server has already replaced, and the next refresh
    # signs everybody out. The cookie rotates — that's where replay detection
    # lives. This doesn't need to.
    csrf_token: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True))
    # Set rather than deleted: a revoked row is what lets a later presentation
    # of the same cookie be answered with "that session is over" instead of
    # "no such session", and it's what stops a reuse-revoked family coming back
    # to life. Expired and revoked rows are swept on the next sign-in by the
    # same person — see oauth2.open_refresh_session.
    revoked_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
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
        # "the replies to comment N" is asked once per conversation on every
        # page of every thread, which is often enough to index.
        Index("ix_comments_parent_id", "parent_id"),
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
    # What this is a reply to, or null for something said to the post itself.
    #
    # **One level, and the schema is what says so** — see ReplyOut in
    # schemas.py, which has no replies of its own. Unbounded nesting is a
    # rendering problem, an indentation problem on a phone and a moderation
    # problem, and on a feed this size it buys nothing. Declaring the depth in
    # the types rather than only enforcing it in a handler means the shape is
    # visible to anybody reading the contract.
    #
    # The cascade is at the database for the reason written above: a comment
    # that goes takes the replies to it whoever issued the DELETE.
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("comments.id", ondelete="CASCADE"), nullable=True
    )

    user: Mapped["User"] = relationship()
    # Added for the notification list, which needs the post's title to say
    # where a comment was left. Nothing else walks it — the comment endpoints
    # all arrive holding the post already — so it is left lazy rather than
    # eagerly loaded, and the one query that wants it asks with selectinload.
    post: Mapped["Post"] = relationship()
    # passive_deletes because the database is already doing it. Without it
    # SQLAlchemy loads every reply in order to delete them one at a time, which
    # is the ORM redoing the work and getting a different answer for any row it
    # happened not to have loaded.
    replies: Mapped[list["Comment"]] = relationship(
        back_populates="parent",
        passive_deletes=True,
        order_by="Comment.created_at, Comment.id",
    )
    parent: Mapped["Comment | None"] = relationship(
        back_populates="replies", remote_side="Comment.id"
    )


class Notification(Base):
    """Somebody addressed you: a reply to your comment, or a comment on your post.

    ── what is in here, and what deliberately isn't ────────────────────────
    Votes are not. A vote is a number moving, and "three people upvoted you" is
    the mechanic this app's design thesis spends a page arguing against — a
    notification with nothing behind it and nowhere to go. Everything here is a
    person having said something to you, which means every row has somewhere to
    take you and something to answer.

    ── one comment, at most one notification ──────────────────────────────
    A reply notifies the person it answers. A top-level comment notifies the
    post's author. Those are the only two rules, and they do not overlap: a
    reply on your own post notifies whoever was replied to, not you as well.
    The alternative — everybody with a stake in the thread hears about
    everything — is how a notification list becomes something people mute.

    ── kind is stored rather than derived ─────────────────────────────────
    It could be worked out from ``comment.parent_id``, and storing it is still
    the right call: a row here is a record that something *happened*, and a
    record that recomputes itself from the current state of other rows is not a
    record. It also means the list endpoint needs no branch to know which
    sentence to build.

    ── everything cascades, and it has to ─────────────────────────────────
    Delete the comment and the notification about it goes: a line that says
    "bea replied to you" pointing at nothing is worse than silence. Delete
    either person — the reader or the actor — and it goes too. All three at the
    database, for the reason the rest of this file gives.
    """

    __tablename__ = "notifications"

    __table_args__ = (
        # The only question asked of this table: "mine, newest first" — and,
        # with read_at IS NULL added, "how many have I not seen". One index
        # answers both, because the filter is the leading column either way.
        Index("ix_notifications_user_id_created_at", "user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # Who it is for.
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    # Who did the thing. Deleting them takes the notification with them, which
    # is right: "somebody replied to you" about an account that no longer
    # exists is a dead end wearing a name.
    actor_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    comment_id: Mapped[int] = mapped_column(
        ForeignKey("comments.id", ondelete="CASCADE")
    )
    # "reply" or "comment". Not an enum column: a CHECK constraint on two
    # values buys a migration every time a third is imagined, and the two
    # values are written down in schemas.NotificationKind where the API can
    # see them.
    kind: Mapped[str]
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=text("now()")
    )
    # Null until seen. A timestamp rather than a boolean because it costs the
    # same and answers "when" as well as "whether".
    read_at: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(timezone=True), nullable=True
    )

    actor: Mapped["User"] = relationship(foreign_keys=[actor_id])
    comment: Mapped["Comment"] = relationship()
