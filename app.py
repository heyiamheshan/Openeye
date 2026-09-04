import json
import logging
import threading
import time
from datetime import datetime
from pathlib import Path

import cv2
import requests
import urllib3
from flask import Flask, Response, jsonify, render_template, request, send_from_directory
from werkzeug.utils import secure_filename

import config
import contacts_store
import escalation
import incident_log
import notifiers
import rules_store
import runtime_state
import scene_analyst
import zones_store
from detector import DetectorThread

app = Flask(__name__)
Path(config.ALERTS_DIR).mkdir(exist_ok=True)
Path(config.UPLOADS_DIR).mkdir(exist_ok=True)
Path("logs").mkdir(exist_ok=True)

log = logging.getLogger(__name__)

ALLOWED_VIDEO_EXTS = {"mp4", "mov", "avi"}
DEMO_SAMPLE_PATH = "demo/sample.mp4"

_detector_thread: DetectorThread | None = None
_detector_lock = threading.Lock()

_camera_lock = threading.Lock()
_camera: cv2.VideoCapture | None = None

_demo_lock = threading.Lock()
_demo_cap: cv2.VideoCapture | None = None
_demo_cap_path: str | None = None


def _get_camera() -> cv2.VideoCapture:
    global _camera
    with _camera_lock:
        if _camera is None or not _camera.isOpened():
            _camera = cv2.VideoCapture(config.CAMERA_INDEX)
        return _camera


def _get_demo_camera():
    global _demo_cap, _demo_cap_path
    path = runtime_state.get_video_path()
    if not path:
        return None
    with _demo_lock:
        if _demo_cap is None or _demo_cap_path != path or not _demo_cap.isOpened():
            if _demo_cap is not None:
                _demo_cap.release()
            _demo_cap = cv2.VideoCapture(path)
            _demo_cap_path = path
        return _demo_cap


def _read_frame():
    """Returns (ok, frame) from the active source — demo video or live webcam."""
    if runtime_state.get_demo_mode():
        cap = _get_demo_camera()
        if cap is None or not cap.isOpened():
            return False, None
        with _demo_lock:
            ok, frame = cap.read()
            if not ok:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = cap.read()
            return ok, frame

    cam = _get_camera()
    with _camera_lock:
        return cam.read()


def _gen_frames():
    while True:
        ok, frame = _read_frame()
        if ok:
            ok, buf = cv2.imencode(".jpg", frame)
            if ok:
                yield (
                    b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
                    + buf.tobytes()
                    + b"\r\n"
                )
        time.sleep(0.04)  # ~25 fps


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/video_feed")
def video_feed():
    return Response(
        _gen_frames(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


@app.route("/current_frame")
def current_frame():
    ok, frame = _read_frame()
    if not ok:
        return jsonify(error="Failed to capture frame"), 503
    ok, buf = cv2.imencode(".jpg", frame)
    if not ok:
        return jsonify(error="Failed to encode frame"), 503
    return Response(buf.tobytes(), mimetype="image/jpeg")


@app.route("/demo_mode", methods=["GET", "POST"])
def demo_mode_route():
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        runtime_state.set_demo_mode(bool(data.get("demo_mode", False)))
    return jsonify(
        demo_mode=runtime_state.get_demo_mode(),
        video_path=runtime_state.get_video_path(),
    )


@app.route("/upload_video", methods=["POST"])
def upload_video():
    file = request.files.get("video")
    if not file or file.filename == "":
        return jsonify(error="No video file provided"), 400
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_VIDEO_EXTS:
        return jsonify(error="Unsupported file type. Use mp4, mov, or avi."), 400

    filename = f"{int(time.time())}_{secure_filename(file.filename)}"
    filepath = Path(config.UPLOADS_DIR) / filename
    file.save(filepath)
    runtime_state.set_video_path(str(filepath))
    return jsonify(ok=True, video_path=str(filepath))


@app.route("/uploads/<path:filename>")
def uploaded_video(filename):
    """Serves uploaded clips so the demo feed can display the analyzed video."""
    return send_from_directory(config.UPLOADS_DIR, filename)


@app.route("/demo/<path:filename>")
def demo_asset(filename):
    """Serves the bundled sample clip so the demo <video> element can play it."""
    return send_from_directory("demo", filename)


@app.route("/demo_run/load_sample", methods=["POST"])
def load_sample_video():
    if not Path(DEMO_SAMPLE_PATH).exists():
        return jsonify(error="Sample video not found on server"), 404
    runtime_state.set_video_path(DEMO_SAMPLE_PATH)
    return jsonify(ok=True, video_path=DEMO_SAMPLE_PATH)


@app.route("/start", methods=["POST"])
def start_monitoring():
    global _detector_thread
    data = request.get_json(silent=True) or {}
    rule = data.get("rule", "").strip()
    if not rule:
        return jsonify(error="Rule is required"), 400

    with _detector_lock:
        if _detector_thread is not None and _detector_thread.is_alive() and _detector_thread.is_active():
            _detector_thread.rule = rule
        else:
            _detector_thread = DetectorThread(rule)
            _detector_thread.start()

    return jsonify(ok=True, rule=rule)


@app.route("/stop", methods=["POST"])
def stop():
    with _detector_lock:
        if _detector_thread is not None:
            _detector_thread.stop()
    return jsonify(ok=True)


@app.route("/alerts/json")
def alerts_json():
    with _detector_lock:
        thread = _detector_thread
    monitoring = bool(thread and thread.is_alive() and thread.is_active())
    data = thread.get_alerts() if thread else []
    return jsonify(monitoring=monitoring, rule=(thread.rule if thread else ""), alerts=data[:10])


@app.route("/alerts/<path:filename>")
def alert_image(filename):
    return send_from_directory(config.ALERTS_DIR, filename)


@app.route("/zones")
def get_zones():
    return jsonify(zones=zones_store.get_zones())


@app.route("/zones", methods=["POST"])
def create_zone():
    data = request.get_json(silent=True) or {}
    name = data.get("name", "").strip()
    points = data.get("points")
    if not name or not points or len(points) < 3:
        return jsonify(error="Zone name and at least 3 points are required"), 400
    zones_store.set_zone(name, points)
    return jsonify(ok=True)


@app.route("/zones/<path:name>", methods=["DELETE"])
def remove_zone(name):
    deleted = zones_store.delete_zone(name)
    if not deleted:
        return jsonify(error="Zone not found"), 404
    affected_rule_ids = rules_store.clear_zone_references(name)
    return jsonify(ok=True, affected_rule_ids=affected_rule_ids)


@app.route("/rules")
def get_rules():
    return jsonify(rules=rules_store.get_rules())


@app.route("/rules", methods=["POST"])
def create_rule():
    data = request.get_json(silent=True) or {}
    rule_text = data.get("rule_text", data.get("text", "")).strip()
    if not rule_text:
        return jsonify(error="Rule text is required"), 400
    zone_name = (data.get("zone_name") or "").strip() or None
    if zone_name and zone_name not in zones_store.get_zones():
        return jsonify(error="Unknown zone"), 400

    rule_type = (data.get("rule_type") or "standard").strip()
    if rule_type not in ("standard", "ppe_check", "proximity"):
        return jsonify(error="Invalid rule_type"), 400

    required_ppe = data.get("required_ppe") or []
    if rule_type == "ppe_check":
        if not isinstance(required_ppe, list) or not all(isinstance(x, str) for x in required_ppe) or not required_ppe:
            return jsonify(error="required_ppe must be a non-empty list of strings for PPE check rules"), 400

    subject = (data.get("subject") or "").strip()
    hazard = (data.get("hazard") or "").strip()
    if rule_type == "proximity":
        if not subject or not hazard:
            return jsonify(error="subject and hazard are required for proximity rules"), 400

    rule = rules_store.add_rule(
        rule_text, zone_name, rule_type=rule_type, required_ppe=required_ppe,
        subject=subject, hazard=hazard,
    )
    return jsonify(ok=True, rule=rule)


@app.route("/rules/<path:rule_id>/toggle", methods=["POST"])
def toggle_rule(rule_id):
    data = request.get_json(silent=True) or {}
    enabled = bool(data.get("enabled", True))
    updated = rules_store.set_enabled(rule_id, enabled)
    if not updated:
        return jsonify(error="Rule not found"), 404
    return jsonify(ok=True)


@app.route("/rules/<path:rule_id>/zone", methods=["PUT"])
def set_rule_zone(rule_id):
    data = request.get_json(silent=True) or {}
    zone_name = (data.get("zone_name") or "").strip() or None
    if zone_name and zone_name not in zones_store.get_zones():
        return jsonify(error="Unknown zone"), 400
    updated = rules_store.set_zone(rule_id, zone_name)
    if not updated:
        return jsonify(error="Rule not found"), 404
    return jsonify(ok=True, rule=updated)


@app.route("/rules/<path:rule_id>", methods=["DELETE"])
def remove_rule(rule_id):
    deleted = rules_store.delete_rule(rule_id)
    if not deleted:
        return jsonify(error="Rule not found"), 404
    return jsonify(ok=True)


@app.route("/rules/<path:rule_id>/text", methods=["PUT"])
def update_rule_text(rule_id):
    """Update a rule's text — used when applying a refinement."""
    data = request.get_json(silent=True) or {}
    new_text = (data.get("rule_text") or "").strip()
    if not new_text:
        return jsonify(error="rule_text is required"), 400
    updated = rules_store.update_rule_text(rule_id, new_text)
    if not updated:
        return jsonify(error="Rule not found"), 404
    return jsonify(ok=True, rule=updated)


_REFINE_PROMPT = """\
A monitoring rule produced a false alarm. \
Original rule: {original_rule}. \
What the system reported: {explanation}. \
The user says this was a false alarm because: {user_correction}. \
Rewrite the rule so it still catches genuine cases but excludes this situation. \
Keep it as a single state-based sentence suitable for single-frame image analysis. \
Respond ONLY with JSON: {{"revised_rule": string, "change_summary": one sentence explaining what changed}}."""

_REFINE_LOG = Path("logs") / "refinements.jsonl"
_refine_lock = threading.Lock()


def _log_refinement(entry: dict):
    """Append a refinement record to logs/refinements.jsonl."""
    with _refine_lock:
        with open(_REFINE_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")


@app.route("/rules/refine", methods=["POST"])
def refine_rule():
    """Send original rule + explanation + user correction to the text model,
    return a proposed revision."""
    data = request.get_json(silent=True) or {}
    original_rule = (data.get("original_rule") or "").strip()
    explanation = (data.get("explanation") or "").strip()
    user_correction = (data.get("user_correction") or "").strip()

    if not original_rule or not user_correction:
        return jsonify(error="original_rule and user_correction are required"), 400

    prompt = _REFINE_PROMPT.format(
        original_rule=original_rule,
        explanation=explanation or "(no explanation available)",
        user_correction=user_correction,
    )

    headers = {
        "Authorization": f"Bearer {config.DASHSCOPE_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": config.TEXT_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "response_format": {"type": "json_object"},
    }

    try:
        try:
            resp = requests.post(
                f"{config.API_BASE_URL}/chat/completions",
                headers=headers, json=payload, timeout=30,
            )
        except requests.exceptions.SSLError:
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            resp = requests.post(
                f"{config.API_BASE_URL}/chat/completions",
                headers=headers, json=payload, timeout=30, verify=False,
            )
        resp.raise_for_status()
    except requests.RequestException as exc:
        log.error("Refine VLM request failed: %s", exc)
        return jsonify(error="Failed to contact the model"), 502

    raw = resp.json()["choices"][0]["message"]["content"].strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        log.error("Refine model returned invalid JSON: %s", raw[:300])
        return jsonify(error="Model returned invalid response"), 502

    revised = (result.get("revised_rule") or "").strip()
    summary = (result.get("change_summary") or "").strip()
    if not revised:
        return jsonify(error="Model did not produce a revised rule"), 502

    # Log the refinement (applied=false until user confirms)
    _log_refinement({
        "timestamp": datetime.now().isoformat(),
        "original_rule": original_rule,
        "explanation": explanation,
        "user_correction": user_correction,
        "revised_rule": revised,
        "change_summary": summary,
        "applied": False,
    })

    return jsonify(revised_rule=revised, change_summary=summary)


@app.route("/incidents")
def get_incidents_route():
    """Alert history: logged incident records, newest-last. Severity is
    backfilled for older records (written before keyword+confidence
    classification existed), and frame_path is mapped to a servable URL."""
    since = request.args.get("since")
    zone = request.args.get("zone")
    severity = request.args.get("severity")
    incidents = incident_log.get_incidents(since=since, zone=zone, severity=severity)
    out = []
    for r in incidents:
        rec = dict(r)
        if not rec.get("severity"):
            rec["severity"] = incident_log.classify_severity(
                rec.get("rule_text", ""), rec.get("explanation", ""),
                rec.get("confidence", 0.0), rec.get("rule_type", "standard"),
            )
        if rec.get("frame_path"):
            rec["thumbnail"] = "/alerts/" + Path(rec["frame_path"]).name
        out.append(rec)
    return jsonify(incidents=out)


def _clamp_hours(value, default: int = 24) -> int:
    try:
        hours = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(hours, 168))


@app.route("/digest/json")
def digest_json():
    """Shift-digest statistics: period_hours, total, by_zone, by_severity,
    busiest_hour for the requested look-back window (default 24h)."""
    hours = _clamp_hours(request.args.get("hours", 24))
    stats = incident_log.compute_stats(incident_log.get_recent(hours))
    return jsonify(
        period_hours=hours,
        total=stats["total"],
        by_zone=stats["by_zone"],
        by_severity=stats["by_severity"],
        busiest_hour=stats["busiest_hour"],
    )


DIGEST_PROMPT_TEMPLATE = (
    "You are a factory safety analyst. Below is a log of monitoring incidents from "
    "{period}. Write a concise shift safety digest with exactly these "
    "sections: 1) Summary — one sentence with the total count and overall "
    "assessment. 2) Patterns — any clustering by zone, by time of day, or by rule "
    "type, stated plainly. 3) Highest concern — the single most serious incident "
    "and why. 4) Recommended action — two or three specific, practical actions a "
    "supervisor could take tomorrow. Keep the whole digest under 200 words. Be "
    "factual and do not speculate beyond what the log shows. Log follows: {log_text}\n\n"
    "Strict rules for your response: Do not invent or cite any standard, SOP, "
    "regulation, policy number, or section reference — none are available to you. "
    "Do not invent specific measurements, distances, or thresholds. Base every "
    "statement only on what appears in the log. Match the tone to the actual "
    "severity: if the incidents are minor or ambiguous, say so plainly rather than "
    "escalating the language. Recommended actions must be general and practical, "
    "phrased as things a supervisor could reasonably do, not as compliance "
    "requirements. If there is only one incident, do not describe patterns — state "
    "that there is insufficient data to identify a pattern. Do not refer to the "
    "monitoring system as a sensor or use sensor-related terminology — it is an "
    "AI camera monitoring system."
)


def _period_label(hours: int) -> str:
    return f"the last {hours} hour" + ("s" if hours != 1 else "")


def _digest_summary(stats: dict, hours: int) -> str:
    sev = stats.get("by_severity", {})
    return (
        f"{stats.get('total', 0)} incident{'s' if stats.get('total', 0) != 1 else ''} "
        f"in {_period_label(hours)} — "
        f"{sev.get('high', 0)} high, {sev.get('medium', 0)} medium, "
        f"{sev.get('low', 0)} low."
    )


@app.route("/digest/ai", methods=["POST"])
def digest_ai():
    """Generates the AI shift digest for the requested window (default 24h).
    Returns a one-line factual summary plus the generated digest text."""
    data = request.get_json(silent=True) or {}
    hours = _clamp_hours(data.get("hours", 24))

    records = incident_log.get_recent(hours)
    stats = incident_log.compute_stats(records)

    if not records:
        return jsonify(
            ok=True,
            summary=f"No incidents recorded in {_period_label(hours)}.",
            digest=None,
            stats=stats,
        )

    log_text = incident_log.build_digest_log_text(records)
    prompt = DIGEST_PROMPT_TEMPLATE.format(log_text=log_text, period=_period_label(hours))

    payload = {
        "model": config.TEXT_MODEL,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {
        "Authorization": f"Bearer {config.DASHSCOPE_API_KEY}",
        "Content-Type": "application/json",
    }
    try:
        try:
            resp = requests.post(
                f"{config.API_BASE_URL}/chat/completions", headers=headers, json=payload, timeout=30,
            )
        except requests.exceptions.SSLError:
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            resp = requests.post(
                f"{config.API_BASE_URL}/chat/completions", headers=headers, json=payload, timeout=30, verify=False,
            )
        resp.raise_for_status()
        digest_text = resp.json()["choices"][0]["message"]["content"].strip()
    except Exception as exc:
        return jsonify(error=f"Digest generation failed: {exc}", stats=stats), 502

    return jsonify(
        ok=True,
        summary=_digest_summary(stats, hours),
        digest=digest_text,
        stats=stats,
    )


# ── Scene Intelligence ─────────────────────────────────────────────────────────


@app.route("/scene/analyse", methods=["POST"])
def scene_analyse():
    """Capture the current frame and send it to the VLM for scene analysis."""
    ok, frame = _read_frame()
    if not ok or frame is None:
        return jsonify(error="Failed to capture frame — check camera or load a demo video"), 503
    ok, buf = cv2.imencode(".jpg", frame)
    if not ok:
        return jsonify(error="Failed to encode frame"), 503
    try:
        result = scene_analyst.analyse_scene(buf.tobytes())
    except RuntimeError as exc:
        return jsonify(error=str(exc)), 502
    return jsonify(ok=True, **result)


@app.route("/scene/apply", methods=["POST"])
def scene_apply():
    """Accept selected suggestion indices, create zones and rules."""
    data = request.get_json(silent=True) or {}
    indices = data.get("indices", [])
    analysis = data.get("analysis", {})
    if not indices or not analysis:
        return jsonify(error="indices and analysis are required"), 400

    suggested_zones = analysis.get("suggested_zones", [])
    suggested_rules = analysis.get("suggested_rules", [])

    # Build a map of zone_name → zone from the suggestions
    zone_map = {}
    for z in suggested_zones:
        name = z.get("name", "").strip()
        if not name:
            continue
        bounds = z.get("approx_bounds")
        if bounds and len(bounds) == 4:
            zone_map[name] = z

    # Create zones as rectangle polygons (4 corners in normalised space)
    zones_created = 0
    for zname, zdata in zone_map.items():
        x1, y1, x2, y2 = zdata["approx_bounds"]
        # Ensure x1 < x2 and y1 < y2
        x1, x2 = min(x1, x2), max(x1, x2)
        y1, y2 = min(y1, y2), max(y1, y2)
        points = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
        zones_store.set_zone(zname, points)
        zones_created += 1

    # Create rules for selected indices
    rules_created = 0
    for idx in indices:
        if not isinstance(idx, int) or idx < 0 or idx >= len(suggested_rules):
            continue
        r = suggested_rules[idx]
        rule_text = (r.get("rule_text") or "").strip()
        if not rule_text:
            continue
        rule_type = r.get("rule_type", "standard")
        zone_name = (r.get("zone_name") or "").strip() or None
        subject = (r.get("subject") or "").strip() or None
        hazard = (r.get("hazard") or "").strip() or None
        required_ppe = r.get("required_ppe") or []

        # Skip zone validation — zone was just created above
        rules_store.add_rule(
            rule_text,
            zone_name=zone_name,
            rule_type=rule_type,
            required_ppe=required_ppe,
            subject=subject,
            hazard=hazard,
        )
        rules_created += 1

    return jsonify(
        ok=True,
        zones_created=zones_created,
        rules_created=rules_created,
    )


# ── Telegram Contacts ──────────────────────────────────────────────────────────


@app.route("/contacts")
def get_contacts():
    return jsonify(contacts=contacts_store.get_contacts())


@app.route("/contacts", methods=["POST"])
def create_contact():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    chat_id = (data.get("telegram_chat_id") or "").strip()
    if not name or not chat_id:
        return jsonify(error="name and telegram_chat_id are required"), 400
    zone_name = (data.get("zone_name") or "").strip() or None

    # Validate no duplicate name or chat_id
    existing = contacts_store.get_contacts()
    for c in existing:
        if c.get("name", "").lower() == name.lower():
            return jsonify(error=f"A contact named '{name}' already exists"), 409
        if c.get("telegram_chat_id") == chat_id:
            return jsonify(error=f"Chat ID {chat_id} is already assigned to '{c.get('name', '?')}'"), 409

    contact = contacts_store.add_contact(name, chat_id, zone_name)
    return jsonify(ok=True, contact=contact)


@app.route("/contacts/<contact_id>", methods=["DELETE"])
def remove_contact(contact_id):
    deleted = contacts_store.delete_contact(contact_id)
    if not deleted:
        return jsonify(error="Contact not found"), 404
    return jsonify(ok=True)


@app.route("/telegram/status")
def telegram_status():
    """Returns the last Telegram delivery status for the header indicator."""
    status = escalation.get_last_delivery()
    configured = bool(config.TELEGRAM_BOT_TOKEN and config.ESCALATION_ENABLED)
    has_contacts = bool(contacts_store.get_contacts())
    return jsonify(configured=configured, has_contacts=has_contacts, **status)


@app.route("/alerts/resend", methods=["POST"])
def resend_alert():
    """Manually send an alert to Telegram — bypasses dedup cooldown.
    Accepts the full alert record from the frontend."""
    data = request.get_json(silent=True) or {}
    zone = data.get("zone")

    contact = contacts_store.get_contact_for_zone(zone)
    if not contact:
        return jsonify(success=False, detail="no contact configured"), 400

    chat_id = contact.get("telegram_chat_id", "")
    if not chat_id:
        return jsonify(success=False, detail="contact has no chat id"), 400

    # Build caption from the alert data
    caption = escalation.format_caption(data)
    image_path = None
    if data.get("id"):
        p = Path(config.ALERTS_DIR) / data["id"]
        if p.exists():
            image_path = str(p)

    result = notifiers.send_telegram(chat_id, caption, image_path)
    return jsonify(**result)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, threaded=True)
