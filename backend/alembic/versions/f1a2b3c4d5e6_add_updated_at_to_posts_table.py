"""Add updated_at column to posts table

Revision ID: f1a2b3c4d5e6
Revises: c9c73eb8e97a
Create Date: 2026-09-07

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, Sequence[str], None] = "c9c73eb8e97a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "posts",
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    # Existing rows: start updated_at equal to created_at instead of "now".
    op.execute("UPDATE posts SET updated_at = created_at")


def downgrade() -> None:
    op.drop_column("posts", "updated_at")
