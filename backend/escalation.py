"""Telegram alert escalation with deduplication and severity routing.

The escalation function is designed to be called from the detection loop
(DetectorThread) and the demo analysis loop (DemoRunThread) immediately
after an alert record is created.  It runs in a background thread so it
never blocks the caller.

DEDUPLICATION
    An in-memory dict keyed by ``(rule_id, zone_name)`` tracks the last
    send time per key.  If a message for the same key was sent within the
    cooldown window, the new alert is recorded as "suppressed — duplicate"
    and no Telegram message is sent.

SEVERITY ROUTING
    low    → dashboard + incident log only, no Telegram
    medium → one Telegram message per cooldown window
    high   → same as medium, shorter cooldown (half), "HIGH SEVERITY" prefix
"""

import logging
import threading
import time
from datetime import datetime
from pathlib import Path

from . import config
from . import contacts_store
from . import notifiers

log = logging.getLogger(__name__)

# Thread-safe cooldown tracker
_cooldown_lock = threading.Lock()
_last_sent: dict[tuple, float] = {}

# Global last-delivery status for the header indicator
_status_lock = threading.Lock()
_last_delivery = {"success": None, "detail": "not configured"}


def get_last_delivery() -> dict:
    with _status_lock:
        return dict(_last_delivery)


def _set_delivery(success: bool | None, detail: str):
    with _status_lock:
        _last_delivery["success"] = success
        _last_delivery["detail"] = detail


def format_caption(alert: dict) -> str:
    """Build the Telegram message caption from an alert record."""
    sev = (alert.get("severity") or "low").upper()
    prefix = "🚨 HIGH SEVERITY\n" if sev == "HIGH" else ""

    rule_text = alert.get("rule", "")
    zone = alert.get("zone") or "Whole frame"
    confidence = int(round(alert.get("confidence", 0.0) * 100))

    try:
        ts = datetime.fromisoformat(alert.get("timestamp", ""))
        time_str = ts.strftime("%H:%M:%S")
    except (ValueError, TypeError):
        time_str = "—"

    explanation = alert.get("explanation", "")

    lines = [
        f"{prefix}Openeye Alert — {sev}",
        "",
        f"Rule: {rule_text}",
        f"Zone: {zone}",
        f"Confidence: {confidence}%",
        f"Time: {time_str}",
        "",
        explanation,
    ]

    # PPE checklist
    items = alert.get("items")
    if items and isinstance(items, list):
        lines.append("")
        lines.append("PPE Checklist:")
        for item in items:
            if isinstance(item, dict):
                name = item.get("item", item.get("name", "?"))
                status = item.get("status", item.get("wearing", "?"))
                lines.append(f"  • {name}: {status}")
            else:
                lines.append(f"  • {item}")

    # Proximity detail
    proximity = alert.get("proximity")
    if proximity:
        lines.append("")
        lines.append(f"Proximity: {proximity}")

    return "\n".join(lines)


def escalate(alert: dict):
    """Evaluate an alert and optionally send a Telegram message.

    Called in a background thread — never blocks the detection loop.
    Mutates *alert* in-place to add a ``delivery`` field."""

    if not config.ESCALATION_ENABLED:
        alert["delivery"] = {
            "channel": "telegram",
            "success": False,
            "detail": "escalation disabled",
            "suppressed": False,
        }
        return

    severity = alert.get("severity", "low")

    # Low severity: dashboard only
    if severity == "low":
        alert["delivery"] = {
            "channel": "telegram",
            "success": False,
            "detail": "dashboard only",
            "suppressed": False,
        }
        _set_delivery(None, "dashboard only")
        return

    # Dedup key
    rule_id = alert.get("rule_id") or alert.get("rule", "")
    zone_name = alert.get("zone") or ""
    key = (rule_id, zone_name)

    # Cooldown: high severity gets half the normal window
    cooldown = config.ESCALATION_COOLDOWN_SECONDS
    if severity == "high":
        cooldown = max(5, cooldown // 2)

    now = time.monotonic()
    with _cooldown_lock:
        last = _last_sent.get(key, 0.0)
        if now - last < cooldown:
            alert["delivery"] = {
                "channel": "telegram",
                "success": False,
                "detail": "suppressed — duplicate",
                "suppressed": True,
            }
            return
        _last_sent[key] = now

    # Resolve contact for this zone
    contact = contacts_store.get_contact_for_zone(alert.get("zone"))
    if not contact:
        alert["delivery"] = {
            "channel": "telegram",
            "success": False,
            "detail": "no contact configured",
            "suppressed": False,
        }
        _set_delivery(False, "no contact configured")
        return

    chat_id = contact.get("telegram_chat_id", "")
    if not chat_id:
        alert["delivery"] = {
            "channel": "telegram",
            "success": False,
            "detail": "contact has no chat id",
            "suppressed": False,
        }
        _set_delivery(False, "contact has no chat id")
        return

    # Build message and send
    caption = format_caption(alert)
    image_path = None
    if alert.get("id"):
        p = Path(config.ALERTS_DIR) / alert["id"]
        if p.exists():
            image_path = str(p)

    result = notifiers.send_telegram(chat_id, caption, image_path)

    alert["delivery"] = {
        "channel": "telegram",
        "success": result["success"],
        "detail": result["detail"],
        "suppressed": False,
    }
    _set_delivery(result["success"], result["detail"])

    if result["success"]:
        log.info("Telegram sent to %s for rule='%s' zone='%s'",
                 chat_id, alert.get("rule", ""), alert.get("zone", ""))
    else:
        log.warning("Telegram failed for rule='%s': %s",
                    alert.get("rule", ""), result["detail"])


def escalate_async(alert: dict):
    """Fire-and-forget wrapper — spawns a daemon thread for escalate()."""
    t = threading.Thread(target=escalate, args=(alert,), daemon=True)
    t.start()
