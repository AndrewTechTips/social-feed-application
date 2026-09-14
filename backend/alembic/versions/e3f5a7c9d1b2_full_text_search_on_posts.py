"""Full-text search on posts

The feed's search was ``title LIKE '%…%'``. That has three problems, in
increasing order of how much they matter:

  1. It only ever looked at the title, so a post about repairing a kettle was
     unfindable by the word "kettle" unless the word happened to be in the
     heading.
  2. It can't use an index. Every search was a sequential scan with a pattern
     match per row, and no amount of btree helps a leading wildcard.
  3. It has no idea what a word is. Searching "repairing" missed "repair",
     searching "kettles" missed "kettle", and a stray ``%`` typed into the box
     was a live wildcard rather than the character the person typed.

A tsvector fixes all three. The column is GENERATED ALWAYS AS ... STORED, so
Postgres recomputes it on every INSERT and UPDATE and there is no path — not a
migration, not psql, not some future script — that can write a row whose index
disagrees with its own text. A trigger would achieve the same with more parts
to keep in step; doing it in the application would mean only the application
ever got it right.

setweight is why this isn't a single to_tsvector call. Title text is stamped
'A' and body text 'B', which is what lets ts_rank put a title match above a
body match (1.0 against 0.4 at the default weights) rather than treating the
whole post as one undifferentiated bag of words.

The index is GIN. A tsvector holds many lexemes per row, and btree can only
index a value as a whole — GIN is the one that indexes the words inside it.

Backfill: none needed. A stored generated column is computed for every
existing row as part of the ADD COLUMN.

Revision ID: e3f5a7c9d1b2
Revises: d7e9f1b3a5c8
Create Date: 2026-09-14

"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e3f5a7c9d1b2"
down_revision: Union[str, Sequence[str], None] = "d7e9f1b3a5c8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Deliberately a copy of models.SEARCH_VECTOR_SQL rather than an import: a
# migration has to keep meaning what it meant on the day it ran, and importing
# today's definition into last year's migration is how a replay stops
# reproducing the schema it built.
SEARCH_VECTOR_SQL = (
    "setweight(to_tsvector('english', coalesce(title, '')), 'A') || "
    "setweight(to_tsvector('english', coalesce(content, '')), 'B')"
)


def upgrade() -> None:
    op.execute(
        f"ALTER TABLE posts ADD COLUMN search_vector tsvector "
        f"GENERATED ALWAYS AS ({SEARCH_VECTOR_SQL}) STORED"
    )
    op.create_index(
        "ix_posts_search_vector",
        "posts",
        ["search_vector"],
        unique=False,
        postgresql_using="gin",
    )


def downgrade() -> None:
    op.drop_index("ix_posts_search_vector", table_name="posts", postgresql_using="gin")
    op.drop_column("posts", "search_vector")
