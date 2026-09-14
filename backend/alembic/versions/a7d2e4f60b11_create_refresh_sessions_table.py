"""Create refresh_sessions table

The table that lets a sign-in outlive an access token without the access token
having to be long-lived.

Why a table at all, when a self-contained refresh JWT would have needed none:
a stateless token cannot be taken back. Signing out would clear the cookie on
the machine doing the signing out and leave the token valid everywhere else
until it expired. Revocation is most of the reason for splitting the tokens in
the first place, and revocation needs somewhere to write "not any more".

What's stored is a SHA-256 of the secret, never the secret — a dump of this
table still gets nobody in. The primary key is the *family* id and survives
rotation: every refresh writes a new hash into the same row, so a second
presentation of an already-rotated secret arrives with a family that exists and
a hash that doesn't match. That can only mean the cookie was copied, and the
whole family is revoked.

previous_hash and rotated_at hold the secret a rotation just replaced, which
stays acceptable for a few seconds. Two tabs sharing a cookie jar and reloading
together both send what the jar held a moment ago, and without that window the
second one is indistinguishable from a replay.

csrf_token is the exception to "nothing readable is stored": it is not a
credential, it opens nothing on its own, and it has to be handed back to the
client on every refresh — which a hash cannot be.

ON DELETE CASCADE on user_id, like every other foreign key in this schema: an
account that goes takes its sessions with it, whoever issued the DELETE.

ix_refresh_sessions_user_id because two operations walk the foreign key the
other way — sweeping a person's dead rows when they sign in, and the cascade
itself. An unindexed FK turns both into a scan.

Revision ID: a7d2e4f60b11
Revises: e3f5a7c9d1b2
Create Date: 2026-09-14

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a7d2e4f60b11"
down_revision: Union[str, Sequence[str], None] = "e3f5a7c9d1b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "refresh_sessions",
        # uuid4().hex — a fixed 32 characters, and no dependency on a Postgres
        # uuid type for a value nothing ever does arithmetic or ordering on.
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("previous_hash", sa.String(length=64), nullable=True),
        sa.Column("rotated_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("csrf_token", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_refresh_sessions_user_id", "refresh_sessions", ["user_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_refresh_sessions_user_id", table_name="refresh_sessions")
    op.drop_table("refresh_sessions")
