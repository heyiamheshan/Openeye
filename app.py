import threading
import time
from pathlib import Path

import cv2
from flask import Flask, Response, jsonify, render_template, request, send_from_directory

import config
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


@app.route("/rule", methods=["POST"])
def set_rule():
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


@app.route("/alerts")
def alerts():
    with _detector_lock:
        thread = _detector_thread
    monitoring = bool(thread and thread.is_alive() and thread.is_active())
    data = thread.get_alerts() if thread else []
    return jsonify(monitoring=monitoring, rule=(thread.rule if thread else ""), alerts=data[:10])


@app.route("/alerts/<path:filename>")
def alert_image(filename):
    return send_from_directory(config.ALERTS_DIR, filename)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, threaded=True)
