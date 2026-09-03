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
import incident_log
import rules_store
import runtime_state
import zones_store
from demo_runner import DemoRunThread
from detector import DetectorThread

app = Flask(__name__)
Path(config.ALERTS_DIR).mkdir(exist_ok=True)
Path(config.UPLOADS_DIR).mkdir(exist_ok=True)

ALLOWED_VIDEO_EXTS = {"mp4", "mov", "avi"}
DEMO_SAMPLE_PATH = "demo/sample.mp4"

_detector_thread: DetectorThread | None = None
_detector_lock = threading.Lock()

_demo_run_thread: DemoRunThread | None = None
_demo_run_lock = threading.Lock()
_demo_run_started_at: str | None = None  # ISO timestamp — used to scope the digest to "this run"

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


@app.route("/demo_run/current_frame")
def demo_run_current_frame():
    """A real frame straight from the loaded demo video, independent of the
    live/demo runtime_state flag — used so zones can be drawn against an
    actual demo-video frame instead of the live webcam or a placeholder."""
    path = runtime_state.get_video_path()
    if not path:
        return jsonify(error="No demo video loaded"), 404
    cap = _get_demo_camera()
    if cap is None or not cap.isOpened():
        return jsonify(error="Cannot open demo video"), 503
    with _demo_lock:
        ok, frame = cap.read()
        if not ok:
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = cap.read()
    if not ok:
        return jsonify(error="Failed to read frame from demo video"), 503
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


@app.route("/demo_run/load_sample", methods=["POST"])
def load_sample_video():
    if not Path(DEMO_SAMPLE_PATH).exists():
        return jsonify(error="Sample video not found on server"), 404
    runtime_state.set_video_path(DEMO_SAMPLE_PATH)
    return jsonify(ok=True, video_path=DEMO_SAMPLE_PATH)


@app.route("/demo_run/start", methods=["POST"])
def demo_run_start():
    global _demo_run_thread, _demo_run_started_at
    all_rules = rules_store.get_rules()
    print(f"[demo_run_start] all rules in rules_store ({len(all_rules)}):")
    for r in all_rules:
        print(
            f"  id={r.get('id')} text={r.get('rule_text')!r} enabled={r.get('enabled')} "
            f"rule_type={r.get('rule_type')} zone_name={r.get('zone_name')!r}"
        )
    enabled_rules = rules_store.get_enabled_rules()
    print(f"[demo_run_start] enabled_rules passed to DemoRunThread ({len(enabled_rules)}): {enabled_rules}")
    if not enabled_rules:
        print("[demo_run_start] REJECTED — no enabled rules, refusing to start a run against nothing")
        return jsonify(error="No enabled rules — add a rule before starting analysis"), 400
    video_path = runtime_state.get_video_path()
    print(f"[demo_run_start] video_path={video_path!r}")
    if not video_path or not Path(video_path).exists():
        return jsonify(error="No video loaded"), 400

    with _demo_run_lock:
        if _demo_run_thread is not None and _demo_run_thread.is_alive() and not _demo_run_thread.done:
            return jsonify(error="A demo run is already in progress"), 409
        _demo_run_started_at = datetime.now().isoformat(timespec="seconds")
        _demo_run_thread = DemoRunThread(enabled_rules, video_path)
        _demo_run_thread.start()

    return jsonify(ok=True)


@app.route("/demo_run/status")
def demo_run_status():
    with _demo_run_lock:
        thread = _demo_run_thread
    if thread is None:
        return jsonify(active=False)
    status = thread.get_status()
    status["active"] = True
    return jsonify(status)


@app.route("/demo_run/frame")
def demo_run_frame():
    with _demo_run_lock:
        thread = _demo_run_thread
    if thread is None:
        return jsonify(error="No demo run"), 404
    frame = thread.get_current_frame()
    if frame is None:
        return jsonify(error="No frame yet"), 503
    return Response(frame, mimetype="image/jpeg")


@app.route("/demo_run/cancel", methods=["POST"])
def demo_run_cancel():
    with _demo_run_lock:
        if _demo_run_thread is not None:
            _demo_run_thread.cancel()
    return jsonify(ok=True)


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


@app.route("/incidents")
def get_incidents_route():
    since = request.args.get("since")
    zone = request.args.get("zone")
    severity = request.args.get("severity")
    incidents = incident_log.get_incidents(since=since, zone=zone, severity=severity)
    return jsonify(incidents=incidents)


@app.route("/digest/stats")
def digest_stats():
    since = request.args.get("since")
    records = incident_log.get_incidents(since=since) if since else incident_log.get_recent(24)
    return jsonify(ok=True, stats=incident_log.compute_stats(records))


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


@app.route("/digest/generate", methods=["POST"])
def digest_generate():
    data = request.get_json(silent=True) or {}
    scope = data.get("scope") or "24h"
    if scope not in ("24h", "demo_run"):
        return jsonify(error="Invalid scope"), 400

    if scope == "demo_run":
        if not _demo_run_started_at:
            return jsonify(ok=True, message="No demo run has been started yet.", digest=None, stats=incident_log.compute_stats([]))
        records = incident_log.get_incidents(since=_demo_run_started_at)
        period = "the current demo run"
    else:
        records = incident_log.get_recent(24)
        period = "the last 24 hours"

    stats = incident_log.compute_stats(records)

    if not records:
        no_incidents_message = (
            "No incidents recorded in the current demo run." if scope == "demo_run"
            else "No incidents recorded in the last 24 hours."
        )
        return jsonify(ok=True, message=no_incidents_message, digest=None, stats=stats)

    log_text = incident_log.build_digest_log_text(records)
    prompt = DIGEST_PROMPT_TEMPLATE.format(log_text=log_text, period=period)

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

    return jsonify(ok=True, digest=digest_text, stats=stats)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, threaded=True)
