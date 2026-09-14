import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from backend.app import models
from backend.app.database import get_db, Base
from backend.app.config import settings
from backend.app.main import app
from backend.app.oauth2 import create_access_token

SQLALCHEMY_DATABASE_URL = f"postgresql://{settings.database_username}:{settings.database_password}@{settings.database_hostname}:{settings.database_port}/{settings.database_name}_test"

engine = create_engine(SQLALCHEMY_DATABASE_URL)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture
def session():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)

    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture
def client(session):
    def override_get_db():
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    # Rate limiter state is in-memory and would leak from one test into the
    # next; turn it off so tests are deterministic. The limits themselves are
    # covered in test_limits.py, which turns it back on and resets it by hand.
    app.state.limiter.enabled = False
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def test_user(client):
    user_data = {
        "username": "andrew",
        "email": "andrew@gmail.com",
        "password": "password1234",
    }
    res = client.post("/users/", json=user_data)

    assert res.status_code == 201
    new_user = res.json()
    # The response is a UserOut and no longer carries an email — but logging in
    # still needs one, so put back what we know we sent.
    new_user["email"] = user_data["email"]
    new_user["password"] = user_data["password"]
    return new_user


@pytest.fixture
def test_user2(client):
    user_data = {
        "username": "andrew123",
        "email": "andrew123@gmail.com",
        "password": "password1234",
    }
    res = client.post("/users/", json=user_data)

    assert res.status_code == 201
    new_user = res.json()
    new_user["email"] = user_data["email"]
    new_user["password"] = user_data["password"]
    return new_user


@pytest.fixture
def token(test_user):
    return create_access_token({"user_id": test_user["id"]})


@pytest.fixture
def authorized_client(client, token):
    client.headers = {**client.headers, "Authorization": f"Bearer {token}"}
    return client


@pytest.fixture
def anonymous_client(client):
    """A second client over the same app that never carries a token.

    Worth knowing: `authorized_client` signs `client` in by mutating its
    headers in place and handing the *same object* back, so asking for both in
    one test gets you two names for one signed-in client. Use this when a test
    needs to see what a signed-out visitor sees after acting as a signed-in
    one.
    """
    return TestClient(app)


@pytest.fixture
def test_posts(test_user, session, test_user2):
    posts_data = [
        {
            "title": "first title",
            "content": "first content",
            "user_id": test_user["id"],
        },
        {
            "title": "2n title",
            "content": "2nd content",
            "user_id": test_user["id"],
        },
        {
            "title": "3rd title",
            "content": "3rd content",
            "user_id": test_user["id"],
        },
        {
            "title": "3rd title",
            "content": "3rd content",
            "user_id": test_user2["id"],
        },
    ]

    posts = [models.Post(**post) for post in posts_data]

    session.add_all(posts)
    session.commit()
    posts = session.scalars(select(models.Post)).all()
    return posts


@pytest.fixture
def draft_post(test_user2, session):
    """An unpublished post belonging to test_user2 — i.e. not the person the
    `authorized_client` fixture signs in as."""
    draft = models.Post(
        title="a quiet draft",
        content="not ready to be read yet",
        published=False,
        user_id=test_user2["id"],
    )
    session.add(draft)
    session.commit()
    session.refresh(draft)
    return draft


@pytest.fixture
def own_draft(test_user, session):
    """An unpublished post belonging to the `authorized_client` user."""
    draft = models.Post(
        title="my own quiet draft",
        content="mine, and not finished",
        published=False,
        user_id=test_user["id"],
    )
    session.add(draft)
    session.commit()
    session.refresh(draft)
    return draft
