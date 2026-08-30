import threading
import time
from pathlib import Path

import cv2
from flask import Flask, Response, jsonify, render_template, request, send_from_directory

import config
import zones_store
from detector import DetectorThread

app = Flask(__name__)
Path(config.ALERTS_DIR).mkdir(exist_ok=True)

_detector_thread: DetectorThread | None = None
_detector_lock = threading.Lock()

_camera_lock = threading.Lock()
_camera: cv2.VideoCapture | None = None


def _get_camera() -> cv2.VideoCapture:
    global _camera
    with _camera_lock:
        if _camera is None or not _camera.isOpened():
            _camera = cv2.VideoCapture(config.CAMERA_INDEX)
        return _camera


def _gen_frames():
    while True:
        cam = _get_camera()
        with _camera_lock:
            ok, frame = cam.read()
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
    cam = _get_camera()
    with _camera_lock:
        ok, frame = cam.read()
    if not ok:
        return jsonify(error="Failed to capture frame"), 503
    ok, buf = cv2.imencode(".jpg", frame)
    if not ok:
        return jsonify(error="Failed to encode frame"), 503
    return Response(buf.tobytes(), mimetype="image/jpeg")


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
    return jsonify(ok=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, threaded=True)
