"""Create saves table — the shelf gets a home on the server

The shelf shipped as `commons.shelf` in localStorage, which works and will keep
working: it is instant, it needs no account, and it went out to the published
demo the day it was written. What it cannot do is follow you to another device,
and a reading list that only exists on one laptop is half a feature.

This is the same move `voted` made for votes — a documented client-side
best-effort turned into a fact the server knows.

The table is shaped like `votes`: a composite primary key over (user_id,
post_id), so saving the same post twice is impossible at the database rather
than in a handler that might forget to check. What it adds is `created_at`,
because a shelf has an order — most recently saved first — where a tally has
none.

Three keys:

  saves_pkey                    (user_id, post_id), which *is* the question
                                "has this person saved that post".
  ix_saves_user_id_created_at   the only query this table really serves — one
                                person's shelf, newest first. The ordering
                                comes out of the index instead of a sort.
  ix_saves_post_id              the other foreign key. Nothing reads by it,
                                but deleting a post does, and an unindexed FK
                                turns that into a scan of every save ever made.

Both foreign keys are ON DELETE CASCADE at the database, the same arrangement
votes and comments have, so the rule holds whoever issues the DELETE.

Revision ID: c1f7a09e4b33
Revises: b8e1c3a75d20
Create Date: 2026-09-20

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c1f7a09e4b33"
down_revision: Union[str, Sequence[str], None] = "b8e1c3a75d20"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "saves",
        sa.Column("user_id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("post_id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="saves_user_id_fkey", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["post_id"], ["posts.id"], name="saves_post_id_fkey", ondelete="CASCADE"
        ),
    )
    op.create_index(
        "ix_saves_user_id_created_at", "saves", ["user_id", "created_at"], unique=False
    )
    op.create_index("ix_saves_post_id", "saves", ["post_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_saves_post_id", table_name="saves")
    op.drop_index("ix_saves_user_id_created_at", table_name="saves")
    op.drop_table("saves")
