"""Add username to users

The public identity. Until now a post carried its author's email address, which
meant anyone who could read the feed could collect them — and anyone who could
count to n could walk GET /users/{id} and collect the rest.

Adding the column is the easy half. The hard half is that this table already
has people in it, so the column arrives nullable, gets filled in from each
address, and only then becomes NOT NULL and UNIQUE. A migration that assumes an
empty table is a migration that works exactly once, on the machine it was
written on.

Derivation: the local part of the address, folded to lower case, anything
outside [a-z0-9_-] dropped, padded or trimmed to the 3–20 the API allows, and
made to start with a letter. Collisions — which are likely, since alex@one.com
and alex@two.com both want "alex" — get a numeric suffix.

Revision ID: b2c4d6e8f0a1
Revises: 889ce0d369d6
Create Date: 2026-09-14

"""

import re
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b2c4d6e8f0a1"
down_revision: Union[str, Sequence[str], None] = "889ce0d369d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Kept in step with schemas.USERNAME_RE / RESERVED_USERNAMES. Deliberately a
# copy rather than an import: a migration has to keep meaning what it meant on
# the day it ran, and importing today's rules into last year's migration is how
# a replay stops reproducing the schema it built.
VALID = re.compile(r"^[a-z][a-z0-9_-]{2,19}$")
RESERVED = {"me", "admin", "api", "root", "commons"}


def derive(email: str) -> str:
    local = (email or "").split("@")[0].lower()
    cleaned = re.sub(r"[^a-z0-9_-]", "", local)
    cleaned = cleaned.lstrip("0123456789_-")  # must start with a letter
    if not cleaned:
        cleaned = "person"
    cleaned = cleaned[:20]
    while len(cleaned) < 3:
        cleaned += "x"
    return cleaned


def upgrade() -> None:
    op.add_column("users", sa.Column("username", sa.String(), nullable=True))

    users = sa.table(
        "users",
        sa.column("id", sa.Integer),
        sa.column("email", sa.String),
        sa.column("username", sa.String),
    )

    conn = op.get_bind()
    rows = conn.execute(sa.select(users.c.id, users.c.email).order_by(users.c.id)).all()

    taken: set[str] = set()
    for user_id, email in rows:
        base = derive(email)
        candidate = base
        suffix = 1
        while candidate in taken or candidate in RESERVED or not VALID.match(candidate):
            suffix += 1
            tail = str(suffix)
            candidate = base[: 20 - len(tail)] + tail
        taken.add(candidate)

        conn.execute(
            users.update().where(users.c.id == user_id).values(username=candidate)
        )

    op.alter_column("users", "username", nullable=False)
    op.create_unique_constraint("users_username_key", "users", ["username"])


def downgrade() -> None:
    op.drop_constraint("users_username_key", "users", type_="unique")
    op.drop_column("users", "username")
