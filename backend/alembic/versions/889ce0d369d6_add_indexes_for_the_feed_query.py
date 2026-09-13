"""Add indexes for the feed query

The feed is the one query that runs on every page load: filter on published,
order by created_at, take a page. Until now the schema had no indexes at all
beyond the primary keys, so that meant a sequential scan and a full sort of
posts, plus a second scan of votes to count them — fine on a laptop with
twenty rows, quadratically less fine than it looks on anything larger.

  ix_posts_published_created_at  serves the feed's WHERE and ORDER BY together
  ix_posts_user_id               the foreign key, and "my own drafts"
  ix_votes_post_id               counting votes *per post*; the votes primary
                                 key leads with user_id and can't answer it

Revision ID: 889ce0d369d6
Revises: f1a2b3c4d5e6
Create Date: 2026-09-13

"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "889ce0d369d6"
down_revision: Union[str, Sequence[str], None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "ix_posts_published_created_at",
        "posts",
        ["published", "created_at"],
        unique=False,
    )
    op.create_index("ix_posts_user_id", "posts", ["user_id"], unique=False)
    op.create_index("ix_votes_post_id", "votes", ["post_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_votes_post_id", table_name="votes")
    op.drop_index("ix_posts_user_id", table_name="posts")
    op.drop_index("ix_posts_published_created_at", table_name="posts")
