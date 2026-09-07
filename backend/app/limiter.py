"""Shared rate limiter.

Lives in its own module so both ``main.py`` and the routers can import it
without creating a circular import (``main`` imports the routers).
"""

from slowapi import Limiter
from slowapi.util import get_remote_address

from .config import settings

# key_func decides "who" a limit is counted against — here, the client IP.
limiter = Limiter(key_func=get_remote_address, enabled=settings.rate_limit_enabled)
