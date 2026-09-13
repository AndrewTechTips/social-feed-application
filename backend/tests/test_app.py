"""App-level concerns: the headers every response carries, and liveness."""

import pytest


def test_healthz_is_open_and_cheap(client):
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


@pytest.mark.parametrize(
    "header, value",
    [
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        ("Referrer-Policy", "no-referrer"),
    ],
)
def test_security_headers_are_on_every_response(client, header, value):
    assert client.get("/healthz").headers[header] == value
    assert client.get("/posts/").headers[header] == value


def test_security_headers_survive_an_error_response(client):
    res = client.get("/posts/999999")
    assert res.status_code == 404
    assert res.headers["X-Content-Type-Options"] == "nosniff"


def test_hsts_is_not_asserted_outside_production(client):
    """Sending HSTS from a development server pins localhost to https in the
    browser's cache for a year, which is a genuinely annoying thing to undo."""
    assert "Strict-Transport-Security" not in client.get("/healthz").headers


def test_hsts_is_asserted_in_production(client, monkeypatch):
    from backend.app import main

    monkeypatch.setattr(main.settings, "environment", "production")
    res = client.get("/healthz")
    assert res.headers["Strict-Transport-Security"] == (
        "max-age=31536000; includeSubDomains"
    )
