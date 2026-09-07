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
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Then the application code.
COPY backend/ ./backend/

# Run as an unprivileged user.
RUN useradd --create-home --uid 1000 appuser && chown -R appuser /usr/src/app
USER appuser

EXPOSE 8000
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
