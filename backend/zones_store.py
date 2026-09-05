"""JSON-backed storage for user-drawn monitoring zones.

Zones are persisted to zones.json at the project root and associated with
one or more rules for geometry-aware verification.
"""

import json
import threading
from pathlib import Path

from . import config

# Path to the JSON file that persists zones at the project root.
_FILE = config.BASE_DIR / "zones.json"
# Lock serialises reads/writes when multiple threads access the store.
_lock = threading.Lock()


def _load() -> dict:
    """Load zones from disk, returning an empty dict if the file is missing or corrupt."""
    if _FILE.exists():
        try:
            return json.loads(_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save(zones: dict):
    """Persist the zones dictionary back to JSON."""
    _FILE.write_text(json.dumps(zones, indent=2))


def get_zones() -> dict:
    """Return all zones as a mapping name -> [[x, y], ...] normalised 0-1 polygon points."""
    with _lock:
        return _load()


def set_zone(name: str, points: list):
    """Add or overwrite a zone polygon."""
    with _lock:
        zones = _load()
        zones[name] = points
        _save(zones)


def delete_zone(name: str) -> bool:
    """Remove a zone by name.  Returns True if the zone existed and was deleted."""
    with _lock:
        zones = _load()
        if name in zones:
            del zones[name]
            _save(zones)
            return True
        return False
