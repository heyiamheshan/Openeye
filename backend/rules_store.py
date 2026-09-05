"""JSON-backed storage for natural-language monitoring rules.

Rules are persisted to rules.json at the project root and kept in memory
behind a thread-safe cache for fast reads by the detector.
"""

import json
import threading
import uuid
from pathlib import Path

from . import config

# Path to the JSON file that persists rules at the project root.
_FILE = config.BASE_DIR / "rules.json"
# Lock serialises reads/writes when multiple threads access the store.
_lock = threading.Lock()


def _load() -> list:
    """Load rules from disk, returning an empty list if the file is missing or corrupt."""
    if _FILE.exists():
        try:
            return json.loads(_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return []
    return []


def _save(rules: list):
    """Persist the rules list back to JSON."""
    _FILE.write_text(json.dumps(rules, indent=2))


def get_rules() -> list:
    """Return every saved rule.  Shape: [{id, rule_text, zone_name, enabled, zone_name_cleared}, ...]."""
    with _lock:
        return _load()


def get_enabled_rules() -> list:
    """Return only rules that are currently enabled for detection."""
    with _lock:
        return [r for r in _load() if r.get("enabled", True)]


def add_rule(
    rule_text: str,
    zone_name: str | None = None,
    rule_type: str = "standard",
    required_ppe: list | None = None,
    subject: str | None = None,
    hazard: str | None = None,
) -> dict:
    """Create a new rule, append it to the store and return the created record."""
    with _lock:
        rules = _load()
        rule = {
            "id": uuid.uuid4().hex,          # Unique identifier used by the UI and detector.
            "rule_text": rule_text,
            "zone_name": zone_name,
            "enabled": True,
            "zone_name_cleared": False,
            "rule_type": rule_type,
        }
        # PPE rules carry the list of required equipment.
        if rule_type == "ppe_check":
            rule["required_ppe"] = required_ppe or []
        # Proximity rules describe what should stay away from a hazard.
        if rule_type == "proximity":
            rule["subject"] = subject or ""
            rule["hazard"] = hazard or ""
        rules.append(rule)
        _save(rules)
        return rule


def set_zone(rule_id: str, zone_name: str | None) -> dict | None:
    """Assign (or clear) the zone for a rule.  Returns the updated rule or None."""
    with _lock:
        rules = _load()
        for r in rules:
            if r["id"] == rule_id:
                r["zone_name"] = zone_name
                r["zone_name_cleared"] = False
                _save(rules)
                return r
        return None


def set_enabled(rule_id: str, enabled: bool) -> bool:
    """Toggle whether a rule is active in the detector.  Returns True if found."""
    with _lock:
        rules = _load()
        for r in rules:
            if r["id"] == rule_id:
                r["enabled"] = enabled
                _save(rules)
                return True
        return False


def update_rule_text(rule_id: str, new_text: str) -> dict | None:
    """Replace the rule_text field. Returns the updated rule or None."""
    with _lock:
        rules = _load()
        for r in rules:
            if r["id"] == rule_id:
                r["rule_text"] = new_text.strip()
                _save(rules)
                return r
        return None


def delete_rule(rule_id: str) -> bool:
    """Remove a rule by id.  Returns True if a rule was removed."""
    with _lock:
        rules = _load()
        new_rules = [r for r in rules if r["id"] != rule_id]
        if len(new_rules) == len(rules):
            return False
        _save(new_rules)
        return True


def clear_zone_references(zone_name: str) -> list:
    """Called when a zone is deleted. Nulls zone_name on any rule that referenced
    it (rules themselves are kept, just revert to whole-frame evaluation) and
    marks them so the UI can show a 'zone deleted' warning. Returns affected ids."""
    with _lock:
        rules = _load()
        affected = []
        for r in rules:
            if r.get("zone_name") == zone_name:
                r["zone_name"] = None
                r["zone_name_cleared"] = True
                affected.append(r["id"])
        if affected:
            _save(rules)
        return affected
