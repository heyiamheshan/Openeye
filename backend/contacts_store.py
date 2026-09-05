"""File-backed JSON store for Telegram escalation contacts."""

import json
import logging
import threading
import uuid
from pathlib import Path

from . import config

log = logging.getLogger(__name__)

# Path to the JSON file that persists contacts at the project root.
_STORE_PATH = config.BASE_DIR / "contacts.json"
# Lock serialises reads/writes when multiple threads access the store.
_lock = threading.Lock()


def _load() -> list:
    """Load contacts from disk, returning an empty list if the file is missing or corrupt."""
    if _STORE_PATH.exists():
        try:
            return json.loads(_STORE_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            return []
    return []


def _save(contacts: list):
    """Persist the contacts list back to JSON."""
    _STORE_PATH.write_text(json.dumps(contacts, indent=2))


def get_contacts() -> list:
    """Return a thread-safe copy of all stored contacts."""
    with _lock:
        return list(_load())


def add_contact(name: str, telegram_chat_id: str, zone_name: str | None = None) -> dict:
    """Create a new contact and append it to the JSON store."""
    contact = {
        "id": uuid.uuid4().hex[:12],                      # Short unique identifier.
        "name": name.strip(),
        "telegram_chat_id": telegram_chat_id.strip(),    # Telegram destination chat.
        "zone_name": zone_name.strip() if zone_name else None,  # Optional zone filter.
    }
    with _lock:
        contacts = _load()
        contacts.append(contact)
        _save(contacts)
    return contact


def delete_contact(contact_id: str) -> bool:
    """Remove the contact with the given id.  Returns True if one was removed."""
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
