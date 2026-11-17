"""In-memory sliding-window counters used for login and registration throttling.

Kept deliberately simple (no extra dependency). Counters live in the API
process, so they reset on restart and are per worker; a multi-server deployment
would move them to a shared store such as Redis.
"""

from __future__ import annotations

import math
import threading
import time
from collections import defaultdict, deque


class SlidingWindowLimiter:
    def __init__(self, clock=time.monotonic) -> None:
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()
        self._clock = clock

    def _prune(self, key: str, window: float) -> deque[float]:
        events = self._events[key]
        cutoff = self._clock() - window
        while events and events[0] <= cutoff:
            events.popleft()
        return events

    def retry_after(self, key: str, limit: int, window: float) -> int:
        """Seconds until another attempt is allowed (0 = allowed now)."""
        with self._lock:
            events = self._prune(key, window)
            if not events:
                self._events.pop(key, None)  # keep memory bounded
                return 0
            if len(events) < limit:
                return 0
            return max(1, math.ceil(events[0] + window - self._clock()))

    def hit(self, key: str) -> None:
        with self._lock:
            self._events[key].append(self._clock())

    def reset(self, key: str) -> None:
        with self._lock:
            self._events.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._events.clear()
