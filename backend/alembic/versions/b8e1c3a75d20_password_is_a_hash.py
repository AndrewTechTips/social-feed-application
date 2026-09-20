"""users.password holds a hash, so call it password_hash

A rename, and the argument for it is only that the old name was a lie. The
column has never held a password: `utils.hash_password` runs before the row is
built and bcrypt output is what goes in. A column called `password` in a table
called `users` is the one name in this schema most likely to be misread by
somebody in a hurry — and the mistake it invites (logging it, returning it,
comparing it to a plaintext) is the expensive kind.

`ALTER TABLE ... RENAME COLUMN` rewrites no rows: Postgres changes the name in
the catalogue and every index, constraint and grant follows it. So this is a
fast migration on any size of table, which is worth knowing because "rename a
column" usually isn't.

Revision ID: b8e1c3a75d20
Revises: f0eb5c913af6
Create Date: 2026-09-20

"""

from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b8e1c3a75d20"
down_revision: Union[str, Sequence[str], None] = "f0eb5c913af6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("users", "password", new_column_name="password_hash")


def downgrade() -> None:
    op.alter_column("users", "password_hash", new_column_name="password")
