"""Searching the feed.

This used to be ``title LIKE '%…%'``. Everything below is either something
that couldn't work before — the body, word stems, punctuation — or something
that has to keep working now that it doesn't: the draft rule, the page
envelope, and the empty box still meaning "everything".
"""

from datetime import datetime, timedelta, UTC

import pytest
from sqlalchemy import select, text

from backend.app import models


@pytest.fixture
def library(test_user, session):
    """A small shelf with words deliberately placed: some in titles, some only
    in bodies, and one word that appears in both so ranking has something to
    say."""
    rows = [
        models.Post(
            title="Notes on repairing a kettle",
            content="The element had gone, which I'm told is the usual thing.",
            user_id=test_user["id"],
        ),
        models.Post(
            title="The good mug",
            content="Nine mugs in the cupboard and one of them is the good one. "
            "I repaired the handle of another once.",
            user_id=test_user["id"],
        ),
        models.Post(
            title="Cold water, six in the morning",
            content="The hard part isn't the water. It's the eleven minutes "
            "between the alarm and the water.",
            user_id=test_user["id"],
        ),
    ]
    session.add_all(rows)
    session.commit()
    return {r.title: r.id for r in rows}


def titles(body) -> list[str]:
    return [item["title"] for item in body["items"]]


def search(client, term, **params):
    res = client.get("/posts/", params={"search": term, **params})
    assert res.status_code == 200
    return res.json()


# ---------------------------------------------------------------------------
# The body is searchable now, which is the whole point
# ---------------------------------------------------------------------------
def test_a_word_only_in_the_body_finds_the_post(client, library):
    """ "element" appears nowhere in any title. Under the old LIKE this post
    was unfindable by the word that describes what it's about."""
    body = search(client, "element")
    assert titles(body) == ["Notes on repairing a kettle"]


def test_a_word_in_the_title_still_finds_it(client, library):
    assert titles(search(client, "kettle")) == ["Notes on repairing a kettle"]


def test_two_words_are_an_and_not_an_or(client, library):
    """websearch_to_tsquery joins bare words with AND, so adding a word
    narrows the result rather than widening it."""
    assert search(client, "water")["total"] == 1
    assert search(client, "water alarm")["total"] == 1
    assert search(client, "water kettle")["total"] == 0


# ---------------------------------------------------------------------------
# Stemming — the thing a substring match can never do
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("term", ["repair", "repairing", "repaired", "repairs"])
def test_any_form_of_a_word_finds_every_other_form(client, library, term):
    """ "repairing" is in one title and "repaired" in another body. Whichever
    form you type, both come back — they share a stem."""
    assert search(client, term)["total"] == 2


def test_a_plural_finds_a_singular(client, library):
    assert titles(search(client, "kettles")) == ["Notes on repairing a kettle"]


def test_stop_words_are_not_indexed(client, library):
    """ "the" is in every one of these posts and matches none of them as a
    word — it isn't a word the index keeps."""
    body = search(client, "the")
    # See matching(): an all-stop-word query falls away rather than emptying
    # the feed, so this is the whole shelf rather than nothing.
    assert body["total"] == len(library)


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------
def test_a_title_match_outranks_a_body_match(client, test_user, session):
    """setweight is what earns this: 'A' for the title, 'B' for the body."""
    session.add_all(
        [
            models.Post(
                title="Sourdough",
                content="Nothing about bread here at all.",
                user_id=test_user["id"],
            ),
            models.Post(
                title="A morning routine",
                content="It mostly involves sourdough, if I'm honest.",
                user_id=test_user["id"],
            ),
        ]
    )
    session.commit()

    assert titles(search(client, "sourdough")) == ["Sourdough", "A morning routine"]


def test_equally_good_matches_come_back_newest_first(client, test_user, session):
    """Relevance leads, recency breaks the tie — so two posts that match a
    search identically still arrive in feed order."""
    start = datetime.now(UTC) - timedelta(days=2)
    session.add_all(
        [
            models.Post(
                title="Beekeeping",
                content="One.",
                user_id=test_user["id"],
                created_at=start,
            ),
            models.Post(
                title="Beekeeping",
                content="Two.",
                user_id=test_user["id"],
                created_at=start + timedelta(days=1),
            ),
        ]
    )
    session.commit()

    body = search(client, "beekeeping")
    assert [item["content"] for item in body["items"]] == ["Two.", "One."]


# ---------------------------------------------------------------------------
# Input that used to be a problem (S9)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("term", ["%", "_", "100%", "a'b", "\\", "-- drop", "'"])
def test_punctuation_is_text_not_syntax(client, library, term):
    """Under LIKE, `%` and `_` were live wildcards. Under to_tsquery, a stray
    apostrophe would have been a 500. websearch_to_tsquery takes all of it as
    the characters somebody typed."""
    res = client.get("/posts/", params={"search": term})
    assert res.status_code == 200


def test_a_wildcard_no_longer_matches_everything(client, library):
    """`%` used to be "match all". Now it's a character that isn't a word, so
    the query has nothing in it and the search falls away — same as an empty
    box, and nothing like "every row because of a metacharacter"."""
    assert search(client, "%")["total"] == len(library)


def test_search_is_length_bounded(client, library):
    res = client.get("/posts/", params={"search": "x" * 101})
    assert res.status_code == 422


def test_an_empty_search_is_the_whole_feed(client, library):
    assert search(client, "")["total"] == len(library)


# ---------------------------------------------------------------------------
# Everything search has to keep honouring
# ---------------------------------------------------------------------------
def test_search_still_hides_other_peoples_drafts(
    client, authorized_client, session, test_user2
):
    """The visibility filter and the search filter are ANDed, not swapped."""
    draft = models.Post(
        title="Beekeeping in secret",
        content="Not finished.",
        published=False,
        user_id=test_user2["id"],
    )
    session.add(draft)
    session.commit()

    assert search(client, "beekeeping")["total"] == 0
    assert search(authorized_client, "beekeeping")["total"] == 0


def test_search_shows_you_your_own_drafts(authorized_client, own_draft):
    assert search(authorized_client, "quiet")["total"] == 1


def test_search_paginates_like_the_feed(client, test_user, session):
    session.add_all(
        [
            models.Post(
                title=f"Beekeeping {n}",
                content="Bees.",
                user_id=test_user["id"],
            )
            for n in range(5)
        ]
    )
    session.commit()

    first = search(client, "beekeeping", page=1, page_size=2)
    assert first["total"] == 5
    assert first["pages"] == 3
    assert first["has_next"] is True
    assert len(first["items"]) == 2

    last = search(client, "beekeeping", page=3, page_size=2)
    assert last["has_next"] is False
    assert len(last["items"]) == 1


# ---------------------------------------------------------------------------
# The column itself
# ---------------------------------------------------------------------------
def test_the_search_vector_is_maintained_by_the_database(session, test_user):
    """It's GENERATED ALWAYS, so nothing in Python ever sets it — and an
    UPDATE that doesn't mention it still rewrites it."""
    post = models.Post(
        title="Marmalade", content="Seville oranges.", user_id=test_user["id"]
    )
    session.add(post)
    session.commit()

    vector = session.scalar(
        select(models.Post.search_vector).where(models.Post.id == post.id)
    )
    assert "marmalad" in vector  # stemmed, and weighted 'A' for the title

    post.title = "Chutney"
    session.commit()
    rewritten = session.scalar(
        select(models.Post.search_vector).where(models.Post.id == post.id)
    )
    assert "marmalad" not in rewritten
    assert "chutney" in rewritten


def test_the_search_index_exists_and_is_gin(session):
    """A GIN index is the only reason this is a lookup rather than a scan of
    every row. If a migration ever drops it, search keeps working and quietly
    gets slow — which is the kind of regression no behavioural test catches."""
    definition = session.execute(
        text(
            "select indexdef from pg_indexes "
            "where tablename = 'posts' and indexname = 'ix_posts_search_vector'"
        )
    ).scalar()
    assert definition is not None, "the search index is gone"
    assert "USING gin" in definition
