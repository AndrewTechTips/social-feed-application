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
    # Rate limiter state is in-memory and would leak across tests; turn it off so
    # tests are deterministic. It has its own dedicated test above/below.
    app.state.limiter.enabled = False
    yield TestClient(app)


@pytest.fixture
def test_user(client):
    user_data = {"email": "andrew@gmail.com", "password": "password1234"}
    res = client.post("/users/", json=user_data)

    assert res.status_code == 201
    new_user = res.json()
    new_user["password"] = user_data["password"]
    return new_user


@pytest.fixture
def test_user2(client):
    user_data = {"email": "andrew123@gmail.com", "password": "password1234"}
    res = client.post("/users/", json=user_data)

    assert res.status_code == 201
    new_user = res.json()
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
