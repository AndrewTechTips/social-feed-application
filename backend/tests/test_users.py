import jwt
import pytest

from backend.app import schemas
from backend.app import settings


def test_create_user(client):
    res = client.post(
        "/users/",
        json={
            "username": "hello123",
            "email": "hello123@gmail.com",
            "password": "password123",
        },
    )
    assert res.status_code == 201

    new_user = schemas.UserOut(**res.json())
    assert new_user.username == "hello123"
    # The public shape has no email in it — see test_identity.py.
    assert "email" not in res.json()


def test_login_user(client, test_user):
    res = client.post(
        "/login",
        data={"username": test_user["email"], "password": test_user["password"]},
    )
    login_res = schemas.Token(**res.json())

    payload = jwt.decode(
        login_res.access_token, settings.secret_key, algorithms=[settings.algorithm]
    )
    id = payload.get("user_id")

    assert id == test_user["id"]
    assert login_res.token_type == "bearer"
    assert res.status_code == 200


@pytest.mark.parametrize(
    "email, password, status_code",
    [
        ("wrongemail@gmail.com", "password123", 401),
        ("hello123@gmail.com", "wrongpassword", 401),
        (None, "password123", 422),
        ("hello123@gmail.com", None, 422),
    ],
)
def test_incorrect_login(test_user, client, email, password, status_code):
    res = client.post("/login", data={"username": email, "password": password})
    assert res.status_code == status_code


@pytest.mark.parametrize(
    "password, status_code",
    [
        ("short", 422),  # under 8 characters
        ("a" * 8, 201),  # exactly the minimum
        ("a" * 72, 201),  # exactly the bcrypt limit (72 ASCII bytes)
        ("a" * 73, 422),  # one byte over
        ("é" * 40, 422),  # 40 characters but 80 bytes -> rejected by the byte check
    ],
)
def test_create_user_password_rules(client, password, status_code):
    res = client.post(
        "/users/",
        json={
            "username": "pwrules",
            "email": "pwrules@example.com",
            "password": password,
        },
    )
    assert res.status_code == status_code


def test_create_user_duplicate_email(client, test_user):
    res = client.post(
        "/users/",
        json={
            "username": "somebodyelse",
            "email": test_user["email"],
            "password": "password1234",
        },
    )
    assert res.status_code == 409
    assert "email" in res.json()["detail"].lower()
