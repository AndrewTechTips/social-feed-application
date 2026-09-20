from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.orm import Session, sessionmaker

from .config import settings

# Assembled from parts rather than formatted into a string — see
# Settings.database_url for the reason (a password is allowed to contain `@`).
SQLALCHEMY_DATABASE_URL = settings.database_url()

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    pool_pre_ping=True,  # test a pooled connection is alive before handing it out
    pool_size=10,  # connections kept open in steady state
    max_overflow=20,  # extra connections allowed during bursts
    pool_recycle=1800,  # drop and reopen a connection after 30 min
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
