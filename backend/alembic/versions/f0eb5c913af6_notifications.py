"""notifications

Somebody addressed you: a reply to your comment, or a comment on your post.

A new table and nothing else — no column added to anything that already exists,
so there is no rewrite and no backfill. Everybody's list starts empty, which is
the truthful state: nothing has been said to anyone since this existed to
record it.

Three foreign keys and all three cascade. The recipient, the actor and the
comment can each go, and when any of them does the notification has nothing
left to say — "bea replied to you" pointing at a deleted comment is worse than
silence. They are left unnamed, unlike the one in 1d54654b9387: these are
created as part of `create_table` and removed by `drop_table`, so nothing ever
has to name them to drop them.

One index, on `(user_id, created_at)`. The only question this table is asked is
"mine, newest first", and the unread count is the same question with
`read_at IS NULL` added — the filter leads on `user_id` either way, so one
index answers both.

`kind` is a plain string rather than a CHECK or an enum type. Two values today,
and either of those would buy a migration the first time a third is imagined;
the values live in schemas.NotificationKind, where the API can see them.

Revision ID: f0eb5c913af6
Revises: 1d54654b9387
Create Date: 2026-09-19 21:17:57.527434

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "f0eb5c913af6"
down_revision: Union[str, Sequence[str], None] = "1d54654b9387"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("actor_id", sa.Integer(), nullable=False),
        sa.Column("comment_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("read_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["comment_id"], ["comments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_notifications_user_id_created_at",
        "notifications",
        ["user_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_notifications_user_id_created_at", table_name="notifications")
    op.drop_table("notifications")
