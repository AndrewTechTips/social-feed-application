"""Add content column to posts table

Revision ID: da93af117ddc
Revises: c5bec11e1630
Create Date: 2026-07-20 17:59:45.597654

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "da93af117ddc"
down_revision: Union[str, Sequence[str], None] = "c5bec11e1630"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("posts", sa.Column("content", sa.String(), nullable=False))


def downgrade() -> None:
    op.drop_column("posts", "content")
