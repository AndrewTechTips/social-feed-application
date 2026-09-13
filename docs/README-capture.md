# Regenerating the screenshots

Everything in `docs/media/` is a real capture of the running app — no mockups,
no hand-editing. That means reproducing them needs the app running, against a
database you don't mind emptying.

Four commands, from the repo root:

```bash
# 1. a throwaway database, migrated to head
createdb commons_shots
DATABASE_NAME=commons_shots alembic -c backend/alembic.ini upgrade head

# 2. the API against it. RATE_LIMIT_ENABLED=false because the capture signs in
#    several times in a row and /login allows five a minute.
DATABASE_NAME=commons_shots RATE_LIMIT_ENABLED=false \
  uvicorn backend.app.main:app --port 8001

# 3. the frontend, in another shell, pointed at port 8001
#    (edit API_BASE in frontend/js/config.js, then put it back afterwards)
cd frontend && python3 -m http.server 5173

# 4. seed, capture, encode
python docs/seed_demo.py
node docs/capture.mjs
python docs/make_gif.py        # needs Pillow: pip install Pillow
```

| File | What it does |
| --- | --- |
| `seed_demo.py` | Empties the database and writes the demo content back through the public API, then spreads `created_at` out so the feed shows a plausible range of ages. Refuses to run against a database named `fastapi`, `social_feed` or `postgres`. |
| `capture.mjs` | Drives Chromium through Playwright (borrowed from `frontend/node_modules`). Takes the five stills, then ~80 numbered frames for the tour. Disables animation first so nothing is caught mid-transition. |
| `make_gif.py` | Assembles the frames into `tour.gif`. Pillow is a docs-time dependency only and is deliberately not in `backend/requirements*.txt`. |

`docs/media/.frames/` is scratch and is gitignored; the PNGs and the GIF beside
it are committed, because a README that only renders after you run a build step
isn't much of a README.
