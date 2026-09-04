import json
import threading
from datetime import datetime, timedelta
from pathlib import Path

import config

_LOG_DIR = Path("logs")
_LOG_FILE = _LOG_DIR / "incidents.jsonl"
_lock = threading.Lock()

# Keyword + confidence severity classification. Danger keywords (fire, smoke,
# collapse, missing helmet, physical contact …) escalate straight to high;
# policy keywords (loitering, unattended, running …) sit at medium. Whatever
# the keywords say, a high-confidence detection can lift the result one tier.
SEVERITY_HIGH_KEYWORDS = (
    "fire", "smoke", "flame", "collapsed", "collapse", "lying on the floor",
    "lying on floor", "lying down", "fallen", "fell", "faint", "unconscious",
    "injur", "bleeding", "blood", "trapped", "stuck", "crushed",
    "intruder", "unauthorized", "trespass", "weapon", "knife", "gun",
    "no helmet", "without a helmet", "without helmet", "not wearing a helmet",
    "helmet missing", "missing helmet", "bare head",
    "touching", "in contact", "physical contact", "very close",
    "crash", "collision", "spill", "wet floor", "blocked exit",
    "exposed wire", "electric shock", "overflow",
)
SEVERITY_MEDIUM_KEYWORDS = (
    "running", "loitering", "loiter", "unattended", "left behind",
    "missing", "not wearing", "absent", "door left open", "open door",
    "near", "close to", "reversing", "parked", "illegal", "queue",
    "gathered", "crowd", "empty", "uncleared", "blocked", "obstruct",
    "present in the frame", "visible",
)

_SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2}


def classify_severity(
    rule_text: str = "",
    explanation: str = "",
    confidence: float = 0.0,
    rule_type: str = "standard",
    proximity: str | None = None,
) -> str:
    """Returns 'high' | 'medium' | 'low' for an alert, combining keyword
    matching over the rule text + explanation with the confidence score
    (each contributes a tier; the higher tier wins)."""
    text = f"{rule_text} {explanation}".lower()
    if proximity:
        text += f" {str(proximity).replace('_', ' ')}"

    if any(k in text for k in SEVERITY_HIGH_KEYWORDS):
        keyword_tier = "high"
    elif any(k in text for k in SEVERITY_MEDIUM_KEYWORDS):
        keyword_tier = "medium"
    else:
        keyword_tier = "low"

    conf = float(confidence or 0.0)
    if conf >= 0.9:
        conf_tier = "high"
    elif conf >= 0.7:
        conf_tier = "medium"
    else:
        conf_tier = "low"

    return max((keyword_tier, conf_tier), key=lambda t: _SEVERITY_ORDER[t])


def _compute_severity(alert: dict) -> str:
    if alert.get("severity"):
        return alert["severity"]
    return classify_severity(
        alert.get("rule", ""),
        alert.get("explanation", ""),
        alert.get("confidence", 0.0),
        alert.get("rule_type", "standard"),
        alert.get("proximity"),
    )


def log_incident(alert: dict) -> dict:
    """Appends a persistent record for a triggered alert to logs/incidents.jsonl.
    Called right after an alert fires, from both the live DetectorThread and
    the one-shot DemoRunThread, so every alert becomes a near-miss record —
    whether or not anyone reviews the live alert feed."""
    frame_path = str(Path(config.ALERTS_DIR) / alert["id"]) if alert.get("id") else None
    record = {
        "timestamp": alert.get("timestamp") or datetime.now().isoformat(timespec="seconds"),
        "rule_text": alert.get("rule", ""),
        "rule_type": alert.get("rule_type", "standard"),
        "zone_name": alert.get("zone"),
        "explanation": alert.get("explanation", ""),
        "confidence": alert.get("confidence", 0.0),
        "frame_path": frame_path,
        "severity": _compute_severity(alert),
    }
    with _lock:
        _LOG_DIR.mkdir(exist_ok=True)
        with _LOG_FILE.open("a") as f:
            f.write(json.dumps(record) + "\n")
    return record


def _parse_ts(ts: str) -> datetime:
    """Records are stored with naive local-time timestamps (datetime.now()).
    A caller-supplied `since` value (e.g. the frontend's JS Date().toISOString(),
    which is UTC and timezone-aware, ending in 'Z') would otherwise crash the
    naive/aware comparison below — normalise any aware datetime to naive by
    dropping tzinfo after converting to local time."""
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt


def _load_all() -> list:
    if not _LOG_FILE.exists():
        return []
    records = []
    with _LOG_FILE.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def get_incidents(since: str | None = None, zone: str | None = None, severity: str | None = None) -> list:
    """Reads the full log, optionally filtered by an ISO `since` timestamp,
    exact zone name, or severity level."""
    records = _load_all()
    if since:
        try:
            since_dt = _parse_ts(since)
            records = [r for r in records if _parse_ts(r["timestamp"]) >= since_dt]
        except (ValueError, KeyError):
            pass
    if zone:
        records = [r for r in records if r.get("zone_name") == zone]
    if severity:
        records = [r for r in records if r.get("severity") == severity]
    return records


def get_recent(hours: int = 24) -> list:
    cutoff = datetime.now() - timedelta(hours=hours)
    records = _load_all()
    result = []
    for r in records:
        try:
            if _parse_ts(r["timestamp"]) >= cutoff:
                result.append(r)
        except (ValueError, KeyError):
            continue
    return result


def compute_stats(records: list) -> dict:
    total = len(records)
    by_zone = {}
    by_severity = {"high": 0, "medium": 0, "low": 0}
    by_rule = {}
    hour_counts = {}

    for r in records:
        zone = r.get("zone_name") or "Whole frame"
        by_zone[zone] = by_zone.get(zone, 0) + 1

        sev = r.get("severity", "low")
        by_severity[sev] = by_severity.get(sev, 0) + 1

        rule = r.get("rule_text", "")
        by_rule[rule] = by_rule.get(rule, 0) + 1

        try:
            hour = _parse_ts(r["timestamp"]).strftime("%H:00")
            hour_counts[hour] = hour_counts.get(hour, 0) + 1
        except (ValueError, KeyError):
            pass

    busiest_hour = max(hour_counts, key=hour_counts.get) if hour_counts else None

    return {
        "total": total,
        "by_zone": by_zone,
        "by_severity": by_severity,
        "by_rule": by_rule,
        "busiest_hour": busiest_hour,
    }


def build_digest_log_text(records: list) -> str:
    """Compact text summary for the LLM prompt — no images, just the facts."""
    lines = []
    for r in records:
        zone = r.get("zone_name") or "whole frame"
        lines.append(
            f"{r.get('timestamp')} | rule: {r.get('rule_text')} | zone: {zone} | "
            f"severity: {r.get('severity')} | confidence: {r.get('confidence')}"
        )
    return "\n".join(lines)
