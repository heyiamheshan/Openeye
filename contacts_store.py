"""File-backed JSON store for Telegram escalation contacts."""

import json
import logging
import threading
import uuid
from pathlib import Path

import config

log = logging.getLogger(__name__)

_STORE_PATH = Path("contacts.json")
_lock = threading.Lock()


def _load() -> list:
    if _STORE_PATH.exists():
        try:
            return json.loads(_STORE_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            return []
    return []


def _save(contacts: list):
    _STORE_PATH.write_text(json.dumps(contacts, indent=2))


def get_contacts() -> list:
    with _lock:
        return list(_load())


def add_contact(name: str, telegram_chat_id: str, zone_name: str | None = None) -> dict:
    contact = {
        "id": uuid.uuid4().hex[:12],
        "name": name.strip(),
        "telegram_chat_id": telegram_chat_id.strip(),
        "zone_name": zone_name.strip() if zone_name else None,
    }
    with _lock:
        contacts = _load()
        contacts.append(contact)
        _save(contacts)
    return contact


def delete_contact(contact_id: str) -> bool:
    with _lock:
        contacts = _load()
        new = [c for c in contacts if c["id"] != contact_id]
        if len(new) == len(contacts):
            return False
        _save(new)
        return True


def get_contact_for_zone(zone_name: str | None) -> dict | None:
    """Returns the contact whose zone_name matches, falling back to the first
    contact with zone_name=null.  Returns None if no contacts are configured."""
    with _lock:
        contacts = _load()

    if not contacts:
        return None

    # Exact zone match
    if zone_name:
        for c in contacts:
            if c.get("zone_name") == zone_name:
                return c

    # Fallback: first contact with no zone assignment
    for c in contacts:
        if not c.get("zone_name"):
            return c

    # Last resort: first contact
    return contacts[0] if contacts else None
