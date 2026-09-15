"""The two-token flow: signing in, staying in, being thrown out.

The happy path is the least interesting thing here. What these pin down is the
set of ways a refresh token can be wrong — missing, malformed, expired,
revoked, replayed, or perfectly good but presented without its CSRF token — and
that every one of them gets the same flat 401 and a cleared cookie.

The cookie's *flags* get their own tests too. HttpOnly, SameSite and the /auth
path are the entire reason this work was worth doing; a refactor that dropped
one of them would leave every functional test below still passing.
"""

from datetime import datetime, timedelta, UTC

import pytest

from backend.app import models, oauth2
from backend.app.config import settings
from backend.app.oauth2 import CSRF_HEADER, REFRESH_COOKIE


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def sign_in(client, user) -> dict:
    res = client.post(
        "/login", data={"username": user["email"], "password": user["password"]}
    )
    assert res.status_code == 200
    return res.json()


def set_cookie_header(res) -> str:
    """The raw Set-Cookie line, which is where the flags live. `res.cookies`
    parses them away, and the flags are most of what's being asserted."""
    for key, value in res.headers.raw:
        if key.decode().lower() == "set-cookie" and value.decode().startswith(
            REFRESH_COOKIE
        ):
            return value.decode()
    raise AssertionError("no refresh cookie was set")


def refresh(client, csrf: str | None, cookie: str | None = "keep"):
    """POST /auth/refresh. `cookie="keep"` uses whatever the client is holding;
    anything else replaces it, and None sends none at all."""
    headers = {CSRF_HEADER: csrf} if csrf is not None else {}
    if cookie == "keep":
        return client.post("/auth/refresh", headers=headers)
    client.cookies.clear()
    if cookie is not None:
        client.cookies.set(REFRESH_COOKIE, cookie)
    return client.post("/auth/refresh", headers=headers)


# ---------------------------------------------------------------------------
# Signing in
# ---------------------------------------------------------------------------
def test_login_returns_an_access_token_and_sets_a_refresh_cookie(client, test_user):
    res = client.post(
        "/login",
        data={"username": test_user["email"], "password": test_user["password"]},
    )
    body = res.json()

    assert res.status_code == 200
    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert body["csrf_token"]
    assert body["expires_in"] > 0
    # The refresh token is not in the body, and that is the point: the client
    # can use the session and cannot read the thing that keeps it.
    assert "refresh_token" not in body
    assert client.cookies.get(REFRESH_COOKIE)


def test_the_cookie_carries_every_flag_that_makes_it_a_refresh_cookie(
    client, test_user
):
    res = client.post(
        "/login",
        data={"username": test_user["email"], "password": test_user["password"]},
    )
    cookie = set_cookie_header(res)

    # HttpOnly is the whole security argument — without it this is localStorage
    # with extra steps.
    assert "HttpOnly" in cookie
    # SameSite=Lax is the CSRF floor: a cross-site POST carries no cookie.
    assert "SameSite=lax" in cookie
    # And the path keeps it off every content route, so no write endpoint ever
    # gains an ambient credential.
    assert f"Path={oauth2.REFRESH_COOKIE_PATH}" in cookie
    # Not Secure in tests, because tests run over http — but the flag exists
    # and is driven by a setting, so this pins the wiring rather than a value.
    assert ("Secure" in cookie) is settings.secure_cookies


def test_a_failed_login_sets_no_cookie_and_opens_no_session(client, test_user, session):
    res = client.post(
        "/login", data={"username": test_user["email"], "password": "wrong-password"}
    )
    assert res.status_code == 401
    assert client.cookies.get(REFRESH_COOKIE) is None
    assert session.query(models.RefreshSession).count() == 0


# ---------------------------------------------------------------------------
# Staying signed in
# ---------------------------------------------------------------------------
def test_refresh_hands_back_a_working_access_token(client, test_user):
    csrf = sign_in(client, test_user)["csrf_token"]

    res = refresh(client, csrf)
    assert res.status_code == 200
    token = res.json()["access_token"]

    me = client.get("/users/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["id"] == test_user["id"]


def test_an_expired_access_token_is_recoverable_without_signing_in_again(
    client, test_user
):
    """The scenario the whole feature exists for: the token in memory has run
    out mid-session, and the person shouldn't notice."""
    import jwt

    from backend.app.config import settings

    csrf = sign_in(client, test_user)["csrf_token"]
    expired = jwt.encode(
        {"user_id": test_user["id"], "exp": datetime.now(UTC) - timedelta(seconds=1)},
        settings.secret_key,
        settings.algorithm,
    )
    assert (
        client.get(
            "/users/me", headers={"Authorization": f"Bearer {expired}"}
        ).status_code
        == 401
    )

    fresh = refresh(client, csrf).json()["access_token"]
    assert (
        client.get(
            "/users/me", headers={"Authorization": f"Bearer {fresh}"}
        ).status_code
        == 200
    )


def test_refresh_rotates_the_cookie_and_keeps_the_csrf_token(client, test_user):
    first = sign_in(client, test_user)
    first_cookie = client.cookies.get(REFRESH_COOKIE)

    second = refresh(client, first["csrf_token"]).json()

    # The cookie rotates — that's where replay detection lives.
    assert client.cookies.get(REFRESH_COOKIE) != first_cookie
    # The CSRF token doesn't, and mustn't: two tabs each hold their own copy of
    # it, and rotating would let the one whose response lands second store a
    # value the server has already replaced.
    assert second["csrf_token"] == first["csrf_token"]


def test_rotation_keeps_the_family_and_does_not_pile_up_rows(
    client, test_user, session
):
    csrf = sign_in(client, test_user)["csrf_token"]
    family = session.query(models.RefreshSession).one().id

    for _ in range(3):
        csrf = refresh(client, csrf).json()["csrf_token"]

    rows = session.query(models.RefreshSession).all()
    assert len(rows) == 1, "rotation should reuse the row, not add one per refresh"
    assert rows[0].id == family


# ---------------------------------------------------------------------------
# Being thrown out
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "cookie",
    [
        None,  # never signed in
        "",  # cleared by something else
        "not-in-the-right-shape",  # no family/secret split
        "deadbeef.deadbeef",  # well-formed and entirely invented
    ],
    ids=["missing", "empty", "malformed", "forged"],
)
def test_a_cookie_that_isnt_ours_is_a_flat_401(client, test_user, cookie):
    csrf = sign_in(client, test_user)["csrf_token"]

    res = refresh(client, csrf, cookie=cookie)

    assert res.status_code == 401
    # Same words every time. Which *way* a refresh token is wrong is exactly
    # what an attacker holding half of one wants to be told.
    assert res.json() == {"detail": "Invalid Credentials"}


def test_a_rejected_refresh_clears_the_cookie(client, test_user):
    sign_in(client, test_user)

    res = refresh(client, "some-csrf-token", cookie="deadbeef.deadbeef")

    assert res.status_code == 401
    cookie = set_cookie_header(res)
    # Expired on the spot: the browser is holding something that can only fail,
    # and leaving it there means every future request carries it.
    assert 'commons_refresh=""' in cookie or "commons_refresh=;" in cookie
    assert "Max-Age=0" in cookie or "expires=Thu, 01 Jan 1970" in cookie.lower()


def test_a_real_secret_from_someone_elses_family_is_rejected(
    client, test_user, test_user2, session
):
    """Half a valid cookie is not a cookie. Pairing one person's family id with
    the other's secret has to fail on the hash, not fall through to a lookup
    that happens to find a row."""
    mine = sign_in(client, test_user)
    my_cookie = client.cookies.get(REFRESH_COOKIE)
    my_family, _, my_secret = my_cookie.partition(".")

    client.cookies.clear()
    sign_in(client, test_user2)
    their_family, _, _ = client.cookies.get(REFRESH_COOKIE).partition(".")

    res = refresh(client, mine["csrf_token"], cookie=f"{their_family}.{my_secret}")
    assert res.status_code == 401


def test_a_second_tab_reloading_at_the_same_moment_is_not_a_replay(
    client, test_user, session
):
    """The grace window, and the reason it exists. Two tabs share a cookie jar;
    reload both at once and both send what the jar held a moment ago. Without
    this, an ordinary second tab revokes the session."""
    first = sign_in(client, test_user)
    as_the_jar_had_it = client.cookies.get(REFRESH_COOKIE)

    assert refresh(client, first["csrf_token"]).status_code == 200
    # The second tab's request was already in flight with the older cookie.
    second = refresh(client, first["csrf_token"], cookie=as_the_jar_had_it)

    assert second.status_code == 200
    session.expire_all()
    assert session.query(models.RefreshSession).one().revoked_at is None


def test_replaying_a_rotated_token_after_the_window_ends_the_whole_session(
    client, test_user, session
):
    """Reuse detection. A copied cookie eventually presents a secret that has
    already been rotated away, long after any tab could still be holding it.
    There's no way to tell which holder is the thief, so neither gets to stay."""
    first = sign_in(client, test_user)
    stolen = client.cookies.get(REFRESH_COOKIE)

    # The legitimate browser refreshes, which rotates the secret.
    refresh(client, first["csrf_token"])
    live_cookie = client.cookies.get(REFRESH_COOKIE)

    # Age the rotation past the grace window — the thief is not racing anybody,
    # they just have an old copy.
    row = session.query(models.RefreshSession).one()
    row.rotated_at = datetime.now(UTC) - oauth2.ROTATION_GRACE - timedelta(seconds=1)
    session.commit()

    assert refresh(client, first["csrf_token"], cookie=stolen).status_code == 401

    session.expire_all()
    assert session.query(models.RefreshSession).one().revoked_at is not None

    # And the browser that did nothing wrong is signed out too, deliberately.
    assert refresh(client, first["csrf_token"], cookie=live_cookie).status_code == 401


def test_an_expired_session_is_rejected(client, test_user, session):
    csrf = sign_in(client, test_user)["csrf_token"]
    row = session.query(models.RefreshSession).one()
    row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    session.commit()

    assert refresh(client, csrf).status_code == 401


def test_a_deleted_account_takes_its_sessions_with_it(client, test_user, session):
    csrf = sign_in(client, test_user)["csrf_token"]
    session.delete(session.get(models.User, test_user["id"]))
    session.commit()

    assert session.query(models.RefreshSession).count() == 0
    assert refresh(client, csrf).status_code == 401


def test_signing_in_again_sweeps_the_dead_rows(client, test_user, session):
    """Housekeeping has no cron job behind it: a person signing in is when
    their own dead rows are cheapest to be rid of."""
    sign_in(client, test_user)
    stale = session.query(models.RefreshSession).one()
    stale_id = stale.id  # read before the sweep detaches the row
    stale.revoked_at = datetime.now(UTC)
    session.commit()

    client.cookies.clear()
    sign_in(client, test_user)

    rows = session.query(models.RefreshSession).all()
    assert len(rows) == 1 and rows[0].id != stale_id


# ---------------------------------------------------------------------------
# CSRF
# ---------------------------------------------------------------------------
def test_a_perfectly_good_cookie_without_a_csrf_token_is_refused(client, test_user):
    """The defence that holds even if SameSite doesn't. A cross-site page can
    make the browser send the cookie in some circumstances; it can never read
    the response that carried the CSRF token, so it can never set the header."""
    sign_in(client, test_user)

    res = client.post("/auth/refresh")
    assert res.status_code == 401


def test_a_wrong_csrf_token_is_refused(client, test_user):
    sign_in(client, test_user)
    assert refresh(client, "not-the-csrf-token").status_code == 401


def test_a_csrf_failure_leaves_the_session_alone(client, test_user, session):
    """A good cookie without a matching header says "this request didn't come
    from our page", not "this session is over". Clearing the cookie there would
    turn a forged request into a forced sign-out — a small denial of service,
    but a real one, and the exact thing CSRF protection is meant to prevent."""
    body = sign_in(client, test_user)
    cookie = client.cookies.get(REFRESH_COOKIE)

    refused = client.post("/auth/refresh", headers={CSRF_HEADER: "wrong"})
    assert refused.status_code == 401
    assert not [
        value
        for key, value in refused.headers.raw
        if key.decode().lower() == "set-cookie"
    ], "a CSRF failure must not touch the cookie"

    session.expire_all()
    assert session.query(models.RefreshSession).one().revoked_at is None
    # And the session still works, from the browser it belongs to.
    assert refresh(client, body["csrf_token"], cookie=cookie).status_code == 200


def test_a_cross_site_post_to_logout_cannot_sign_you_out(client, test_user, session):
    """The same attack aimed at the other endpoint. SameSite=Lax means such a
    request arrives with no cookie at all, so there is nothing to clear — and
    clearing anyway would delete the reader's cookie on somebody else's say-so."""
    sign_in(client, test_user)

    client.cookies.clear()
    forged = client.post("/auth/logout")
    assert forged.status_code == 204
    assert not [
        value
        for key, value in forged.headers.raw
        if key.decode().lower() == "set-cookie"
    ], "nothing was presented, so there is nothing to expire"

    session.expire_all()
    assert session.query(models.RefreshSession).one().revoked_at is None


def test_the_csrf_token_keeps_working_across_rotations(client, test_user):
    """The other half of "it doesn't rotate": a second tab that has held the
    same value since sign-in is not locked out by the first tab refreshing."""
    first = sign_in(client, test_user)
    for _ in range(3):
        assert refresh(client, first["csrf_token"]).status_code == 200


def test_a_csrf_token_from_another_session_is_refused(client, test_user, test_user2):
    """It is bound to the session, not merely well-formed."""
    sign_in(client, test_user)
    mine = client.cookies.get(REFRESH_COOKIE)

    client.cookies.clear()
    theirs = sign_in(client, test_user2)["csrf_token"]

    assert refresh(client, theirs, cookie=mine).status_code == 401


def test_the_csrf_check_happens_after_the_cookie_is_proven(client, test_user, session):
    """Order matters: checking CSRF first would make the endpoint answer
    differently for a bad cookie with a good header than for a bad cookie with
    a bad one, which is a way to test cookies for free."""
    sign_in(client, test_user)
    good = refresh(client, "wrong", cookie="deadbeef.deadbeef")
    bad = refresh(client, None, cookie="deadbeef.deadbeef")
    assert good.status_code == bad.status_code == 401
    assert good.json() == bad.json()


# ---------------------------------------------------------------------------
# Signing out
# ---------------------------------------------------------------------------
def test_logout_revokes_the_session_and_clears_the_cookie(client, test_user, session):
    body = sign_in(client, test_user)

    res = client.post("/auth/logout", headers={CSRF_HEADER: body["csrf_token"]})
    assert res.status_code == 204
    assert (
        "Max-Age=0" in set_cookie_header(res)
        or "expires=" in set_cookie_header(res).lower()
    )

    session.expire_all()
    assert session.query(models.RefreshSession).one().revoked_at is not None


def test_a_revoked_session_cannot_be_refreshed(client, test_user):
    body = sign_in(client, test_user)
    cookie = client.cookies.get(REFRESH_COOKIE)

    client.post("/auth/logout", headers={CSRF_HEADER: body["csrf_token"]})

    # Revoked server-side, so a copy of the cookie taken beforehand is dead
    # too. Clearing the cookie alone would only have ended it on this machine.
    assert refresh(client, body["csrf_token"], cookie=cookie).status_code == 401


def test_logging_out_with_nothing_to_log_out_of_still_succeeds(client):
    """Someone asking to leave is never told no."""
    assert client.post("/auth/logout").status_code == 204


def test_logout_without_a_csrf_token_leaves_the_session_alone(
    client, test_user, session
):
    """Forcing a stranger to sign out is a small attack, but it is one."""
    sign_in(client, test_user)

    assert client.post("/auth/logout").status_code == 204

    session.expire_all()
    assert session.query(models.RefreshSession).one().revoked_at is None


def test_signing_out_one_browser_leaves_the_other_signed_in(
    client, anonymous_client, test_user
):
    """Sessions are per-browser, which is what the family id is for."""
    here = sign_in(client, test_user)
    there = sign_in(anonymous_client, test_user)

    client.post("/auth/logout", headers={CSRF_HEADER: here["csrf_token"]})

    assert refresh(client, here["csrf_token"]).status_code == 401
    assert refresh(anonymous_client, there["csrf_token"]).status_code == 200


# ---------------------------------------------------------------------------
# The stored shape
# ---------------------------------------------------------------------------
def test_nothing_usable_is_stored(client, test_user, session):
    """A dump of this table should get nobody in."""
    body = sign_in(client, test_user)
    cookie = client.cookies.get(REFRESH_COOKIE)
    _, _, secret = cookie.partition(".")

    row = session.query(models.RefreshSession).one()
    # The secret — the half that is actually a credential — is only ever a
    # hash. The CSRF token is stored readable on purpose and is not one: on its
    # own it opens nothing, and it has to be handed back on every refresh.
    assert secret != row.token_hash
    assert secret not in row.csrf_token
    assert len(row.token_hash) == 64
    assert row.csrf_token == body["csrf_token"]


# ---------------------------------------------------------------------------
# Where the Secure flag comes from
#
# It follows `environment` rather than defaulting either way, because both
# defaults are wrong on their own: True breaks every development machine
# silently, and False is a security property kept in a deployment checklist.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("environment", "override", "expected"),
    [
        ("development", None, False),
        ("production", None, True),
        # An explicit setting still wins — for TLS terminated in front of a
        # service that doesn't call itself production.
        ("development", True, True),
        ("production", False, False),
    ],
)
def test_secure_cookies_follows_the_environment(environment, override, expected):
    from backend.app.config import Settings

    probe = settings.model_copy(
        update={"environment": environment, "cookie_secure": override}
    )
    assert isinstance(probe, Settings)
    assert probe.secure_cookies is expected
