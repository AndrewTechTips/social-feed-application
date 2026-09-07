"""Central logging setup.

Call ``configure_logging()`` once at startup (see ``main.py``). Everywhere else,
just do ``logger = logging.getLogger(__name__)`` and log normally — format, level
and destination are decided here, in one place.
"""

from logging.config import dictConfig

from .config import settings


def configure_logging() -> None:
    level = settings.log_level.upper()

    dictConfig(
        {
            "version": 1,
            # keep loggers that libraries (uvicorn, sqlalchemy) already created
            "disable_existing_loggers": False,
            "formatters": {
                "standard": {
                    "format": "%(asctime)s %(levelname)-8s %(name)s | %(message)s",
                    "datefmt": "%Y-%m-%dT%H:%M:%S%z",
                }
            },
            "handlers": {
                "console": {
                    "class": "logging.StreamHandler",
                    "formatter": "standard",
                    "stream": "ext://sys.stdout",
                }
            },
            "root": {"handlers": ["console"], "level": level},
            "loggers": {
                "uvicorn.error": {"level": level},
                # access logs are noisy; our own middleware logs requests instead
                "uvicorn.access": {"level": "WARNING"},
            },
        }
    )
