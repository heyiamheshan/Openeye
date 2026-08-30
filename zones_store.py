import json
import threading
from pathlib import Path

_FILE = Path("zones.json")
_lock = threading.Lock()


def _load() -> dict:
    if _FILE.exists():
        try:
            return json.loads(_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save(zones: dict):
    _FILE.write_text(json.dumps(zones, indent=2))


def get_zones() -> dict:
    """name -> [[x, y], ...] normalised 0-1 polygon points"""
    with _lock:
        return _load()


def set_zone(name: str, points: list):
    with _lock:
        zones = _load()
        zones[name] = points
        _save(zones)


def delete_zone(name: str) -> bool:
    with _lock:
        zones = _load()
        if name in zones:
            del zones[name]
            _save(zones)
            return True
        return False
