"""Telegram notification sender for Openeye alerts."""

import logging
from pathlib import Path

import requests

import config

log = logging.getLogger(__name__)

_TG_API = "https://api.telegram.org/bot{token}/{method}"
_warned_missing_token = False


def send_telegram(chat_id: str, caption: str, image_path: str | None = None) -> dict:
    """Send a Telegram message — with photo if *image_path* is readable,
    otherwise a plain text message.

    Returns ``{"success": bool, "detail": str}``.  Never raises."""
    global _warned_missing_token

    if not config.TELEGRAM_BOT_TOKEN:
        if not _warned_missing_token:
            log.info("Telegram not configured — TELEGRAM_BOT_TOKEN is empty")
            _warned_missing_token = True
        return {"success": False, "detail": "not configured"}

    # Telegram Bot API uses token in URL, not Bearer header
    url_photo = _TG_API.format(token=config.TELEGRAM_BOT_TOKEN, method="sendPhoto")
    url_text = _TG_API.format(token=config.TELEGRAM_BOT_TOKEN, method="sendMessage")

    try:
        # Try sending with photo first
        if image_path:
            p = Path(image_path)
            if p.exists() and p.is_file():
                with open(p, "rb") as fh:
                    files = {"photo": (p.name, fh, "image/jpeg")}
                    data = {"chat_id": chat_id, "caption": caption[:1024]}
                    resp = requests.post(url_photo, data=data, files=files, timeout=20)
                if resp.status_code == 200:
                    return {"success": True, "detail": "sent"}
                # If photo fails (e.g. caption too long), fall through to text
                log.warning("sendPhoto failed (%s), falling back to text", resp.status_code)

        # Fall back to plain text message
        payload = {"chat_id": chat_id, "text": caption[:4096]}
        resp = requests.post(url_text, json=payload, timeout=20)
        if resp.status_code == 200:
            return {"success": True, "detail": "sent"}

        detail = resp.text[:200] if resp.text else f"HTTP {resp.status_code}"
        log.error("Telegram send failed: %s", detail)
        return {"success": False, "detail": detail}

    except requests.RequestException as exc:
        log.error("Telegram network error: %s", exc)
        return {"success": False, "detail": str(exc)[:200]}
    except Exception as exc:
        log.error("Telegram unexpected error: %s", exc)
        return {"success": False, "detail": str(exc)[:200]}
