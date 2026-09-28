# Build from the REPO ROOT so the image mirrors the repo layout and
# `backend.app...` / `from backend.app import` resolve exactly like they do
# locally and in the tests:
#   docker build -f backend/Dockerfile -t social-feed-api .
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/usr/src/app

WORKDIR /usr/src/app

# Dependencies first: this layer is only rebuilt when requirements.txt changes.
#
# That file is generated — the whole resolved graph, pinned and hashed, from
# requirements.in (see backend/scripts/lock.py). Two things follow. The image
# is reproducible: rebuilding it next month installs the same bytes rather than
# whatever has been published since. And this layer's cache key is now honest,
# because the file only changes when somebody relocks.
#
# `--require-hashes` is redundant while every line has a hash, and is here to
# make it a build failure rather than a silent downgrade if one ever doesn't.
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r backend/requirements.txt

# Then the application code.
COPY backend/ ./backend/

# Run as an unprivileged user.
RUN useradd --create-home --uid 1000 appuser && chown -R appuser /usr/src/app
USER appuser

EXPOSE 8000
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
