"""Create comments table

The first table in this schema that hangs off two others, and so the first
place the delete rules have to be written down rather than assumed.

Both foreign keys are ON DELETE CASCADE, which is the same arrangement votes
have and for the same reason: the cleanup has to hold whoever issues the
DELETE. A post that goes takes the conversation around it with it. An account
that goes takes what that person said. Neither of those is a decision the
application layer should be able to forget to make.

Two indexes:

  ix_comments_post_id_created_at  the only query this table really serves —
                                  the comments on one post, in the order they
                                  were written. Leading with post_id is what
                                  makes it usable; created_at on the end means
                                  the ordering comes out of the index instead
                                  of a sort.
  ix_comments_user_id             the other foreign key. Nothing reads by it
                                  today, but deleting an account does, and an
                                  unindexed FK turns that into a scan of every
                                  comment ever written.

Revision ID: d7e9f1b3a5c8
Revises: b2c4d6e8f0a1
Create Date: 2026-09-14

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d7e9f1b3a5c8"
down_revision: Union[str, Sequence[str], None] = "b2c4d6e8f0a1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "comments",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("content", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("post_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["post_id"], ["posts.id"], name="comments_post_id_fkey", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="comments_user_id_fkey", ondelete="CASCADE"
        ),
    )
    op.create_index(
        "ix_comments_post_id_created_at",
        "comments",
        ["post_id", "created_at"],
        unique=False,
    )
    op.create_index("ix_comments_user_id", "comments", ["user_id"], unique=False)


def downgrade() -> None:
    # The indexes go with the table; dropping them first only says so out loud.
    op.drop_index("ix_comments_user_id", table_name="comments")
    op.drop_index("ix_comments_post_id_created_at", table_name="comments")
    op.drop_table("comments")
