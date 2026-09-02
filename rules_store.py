import json
import threading
import uuid
from pathlib import Path

_FILE = Path("rules.json")
_lock = threading.Lock()


def _load() -> list:
    if _FILE.exists():
        try:
            return json.loads(_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return []
    return []


def _save(rules: list):
    _FILE.write_text(json.dumps(rules, indent=2))


def get_rules() -> list:
    """[{id, rule_text, zone_name, enabled, zone_name_cleared}, ...]"""
    with _lock:
        return _load()


def get_enabled_rules() -> list:
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
    with _lock:
        rules = _load()
        rule = {
            "id": uuid.uuid4().hex,
            "rule_text": rule_text,
            "zone_name": zone_name,
            "enabled": True,
            "zone_name_cleared": False,
            "rule_type": rule_type,
        }
        if rule_type == "ppe_check":
            rule["required_ppe"] = required_ppe or []
        if rule_type == "proximity":
            rule["subject"] = subject or ""
            rule["hazard"] = hazard or ""
        rules.append(rule)
        _save(rules)
        return rule


def set_enabled(rule_id: str, enabled: bool) -> bool:
    with _lock:
        rules = _load()
        for r in rules:
            if r["id"] == rule_id:
                r["enabled"] = enabled
                _save(rules)
                return True
        return False


def delete_rule(rule_id: str) -> bool:
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
