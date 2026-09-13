#!/usr/bin/env python3
"""Fill a throwaway database with the content the README screenshots show.

The screenshots in docs/media are captures of the real app, which means they
need real rows behind them. This writes them through the public API — no
direct inserts, so whatever it produces is something the API would actually
accept.

Point it at a database you don't mind losing; it empties the tables first so
repeated runs give identical screenshots.

    createdb commons_shots
    DATABASE_NAME=commons_shots alembic -c backend/alembic.ini upgrade head
    DATABASE_NAME=commons_shots uvicorn backend.app.main:app --port 8001
    python docs/seed_demo.py

Then:  node docs/capture.mjs && python docs/make_gif.py
"""

from __future__ import annotations

import itertools
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("DEMO_API", "http://127.0.0.1:8001")
DB = os.environ.get("DATABASE_NAME", "commons_shots")
PW = "commons-demo-pw"


def wipe() -> None:
    """Empty the tables so a re-run reproduces the same feed exactly."""
    if DB in ("fastapi", "social_feed", "postgres"):
        sys.exit(
            f"refusing to wipe {DB!r} — point DATABASE_NAME at a throwaway database"
        )
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from sqlalchemy import create_engine, text

    from backend.app.config import settings

    url = (
        f"postgresql://{settings.database_username}:{settings.database_password}"
        f"@{settings.database_hostname}:{settings.database_port}/{DB}"
    )
    with create_engine(url).begin() as conn:
        conn.execute(text("TRUNCATE votes, posts, users RESTART IDENTITY CASCADE"))
    print(f"emptied {DB}")

def call(path, data=None, form=None, token=None):
    headers, body = {}, None
    if form is not None:
        body = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(API + path, data=body, headers=headers)
    with urllib.request.urlopen(req) as r:
        raw = r.read()
        return json.loads(raw) if raw else None



def stagger(ids: list[int]) -> None:
    """Spread created_at out so the feed shows a realistic range of ages
    instead of eleven posts all made in the same second."""
    from sqlalchemy import create_engine, text

    from backend.app.config import settings

    url = (
        f"postgresql://{settings.database_username}:{settings.database_password}"
        f"@{settings.database_hostname}:{settings.database_port}/{DB}"
    )
    # newest first, matching the order POSTS were created (ids[-1] is the draft)
    ages = ["12 days", "8 days", "5 days", "3 days", "2 days", "1 day",
            "7 hours", "3 hours", "1 hour", "16 minutes", "40 minutes"]
    with create_engine(url).begin() as conn:
        for pid, age in zip(ids, ages):
            conn.execute(
                text("UPDATE posts SET created_at = now() - CAST(:age AS interval), "
                     "updated_at = now() - CAST(:age AS interval) WHERE id = :pid"),
                {"age": age, "pid": pid},
            )
    print("timestamps staggered")


def main() -> int:
    wipe()
    PEOPLE = ["maren.holt@example.com", "j.okafor@example.com",
              "tessa.ward@example.com", "rafa.linden@example.com"]
    tokens = {}
    for email in PEOPLE:
        try:
            call("/users/", {"email": email, "password": PW})
        except urllib.error.HTTPError as e:
            if e.code != 409:
                raise
        tokens[email] = call("/login", form={"username": email, "password": PW})["access_token"]
    print("registered", len(tokens))

    POSTS = [
        (0, "The library that stays open all night",
         "There's a reading room near the old tram depot that never closes. No membership, no "
         "desk, no one checking whether you belong there. You just walk in.\n\n"
         "I've been going on Thursdays for about a year now. The regulars have worked out an "
         "unspoken arrangement about the good chairs — the two by the radiator go to whoever "
         "arrived first, and nobody has ever said this out loud.\n\n"
         "What strikes me is how little it needs to work. A door that opens, some light, and an "
         "assumption that people will mostly be decent about the chairs."),
        (1, "Against the infinite feed",
         "Every feed I use is designed so that it never ends, and I've started to think that's "
         "the whole problem. Not the algorithm, not the ads — just the absence of a bottom.\n\n"
         "A newspaper ends. A letter ends. You finish it and you've finished something. The "
         "endless scroll removes the one signal that tells you it's fine to stop, and then we "
         "blame ourselves for not stopping."),
        (2, "Notes on repairing a kettle",
         "The element had gone, which I'm told is the usual thing. Twelve pounds for the part "
         "and about forty minutes, most of it spent finding a screwdriver small enough.\n\n"
         "The replacement kettle would have been thirty-five, so the saving is real but modest, "
         "and that isn't really why I did it. I did it because a kettle you have opened up is a "
         "different object afterwards — you know what's in there."),
        (3, "Cold water, six in the morning",
         "The trick nobody mentions is that the hard part isn't the water. It's the eleven "
         "minutes between the alarm and the water, which is where every argument against it "
         "gets made.\n\nOnce you're in, it's simple. Loud, but simple."),
        (0, "A short defence of the corner shop",
         "It costs more. That's true and there's no arguing it away. But the corner shop knows "
         "that I buy the same four things, and last winter when I was ill for a fortnight, "
         "someone noticed I hadn't been in."),
        (1, "What the allotment taught me about deadlines",
         "You cannot rush a leek. This sounds like a fridge magnet, and I resented it for two "
         "full seasons before I understood it properly.\n\n"
         "The work is real and it matters, but the timeline belongs to the leek. Most of the "
         "planning I did was an attempt to negotiate with something that does not negotiate."),
        (2, "Three weeks without a phone in the bedroom",
         "I bought a clock. That's the entire intervention — an actual clock, seven pounds, "
         "with hands on it.\n\nI'm sleeping better, though I'd be lying if I said I knew it was "
         "the phone. It might just be that I've started going to bed at a sensible hour because "
         "there's nothing else to do in there."),
        (3, "The bus timetable is a work of fiction",
         "The 14 is scheduled every twelve minutes. In practice it arrives in pairs, roughly "
         "every twenty-five, and the second one is always empty.\n\n"
         "I've stopped checking. The walk to the next stop takes eight minutes and I've never "
         "once regretted taking it."),
        (0, "Learning an instrument at thirty-four",
         "Badly, is the answer. Loudly and badly, with the window shut.\n\n"
         "But I can play three songs now that I could not play in January, and nobody had to "
         "give me permission to try."),
        (1, "On lending books you expect to lose",
         "I've given away maybe sixty books and had perhaps fifteen come back. For a long time "
         "I found this annoying enough to keep a list.\n\n"
         "I threw the list out. The books are doing more good wherever they are than they were "
         "doing on the shelf, arranged by colour, being looked at by me."),
        (2, "Winter swimming, unfinished",
         "Still working out what I actually think about this one. Something about the difference "
         "between a habit and a personality, and I don't have the end of it yet.", False),
    ]

    ids = []
    for entry in POSTS:
        who, title, content = PEOPLE[entry[0]], entry[1], entry[2]
        published = entry[3] if len(entry) > 3 else True
        p = call("/posts/", {"title": title, "content": content, "published": published},
                 token=tokens[who])
        ids.append(p["id"])
    print("created posts", ids)

    VOTES = {ids[1]: 4, ids[2]: 2, ids[3]: 1, ids[5]: 3, ids[6]: 1,
             ids[8]: 2, ids[9]: 3, ids[0]: 2, ids[7]: 1}
    for pid, n in VOTES.items():
        for email in itertools.islice(PEOPLE, n):
            try:
                call("/vote/", {"post_id": pid, "dir": 1}, token=tokens[email])
            except urllib.error.HTTPError:
                pass
    print("votes applied")
    stagger(ids)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
