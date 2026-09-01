import base64
import json
import re
import threading
import time
from collections import deque
from datetime import datetime
from io import BytesIO
from pathlib import Path
from queue import Queue

import cv2
import requests
import urllib3
from PIL import Image

import config
import runtime_state
import zones_store

_demo_lock = threading.Lock()
_demo_cap: cv2.VideoCapture | None = None
_demo_cap_path: str | None = None


def _get_demo_capture(path: str) -> cv2.VideoCapture:
    global _demo_cap, _demo_cap_path
    if _demo_cap is None or _demo_cap_path != path or not _demo_cap.isOpened():
        if _demo_cap is not None:
            _demo_cap.release()
        _demo_cap = cv2.VideoCapture(path)
        _demo_cap_path = path
    return _demo_cap


def _fetch_demo_frame(path: str) -> bytes:
    with _demo_lock:
        cap = _get_demo_capture(path)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open demo video: {path}")
        ok, frame = cap.read()
        if not ok:
            # loop back to the start
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = cap.read()
        if not ok:
            raise RuntimeError("Failed to read frame from demo video")
    ok, buf = cv2.imencode(".jpg", frame)
    if not ok:
        raise RuntimeError("Failed to encode frame as JPEG")
    return buf.tobytes()


def point_in_polygon(point: tuple, polygon: list) -> bool:
    """Ray casting algorithm. point=(x, y), polygon=[[x, y], ...], all normalised 0-1."""
    x, y = point
    n = len(polygon)
    if n < 3:
        return False
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def fetch_frame() -> bytes:
    if runtime_state.get_demo_mode():
        path = runtime_state.get_video_path()
        if not path:
            raise RuntimeError("Demo mode is enabled but no video has been uploaded")
        return _fetch_demo_frame(path)

    cap = cv2.VideoCapture(config.CAMERA_INDEX)
    try:
        if not cap.isOpened():
            raise RuntimeError("Cannot open webcam")
        frame = None
        for _ in range(config.CAMERA_WARMUP_FRAMES):
            ok, frame = cap.read()
            if not ok:
                raise RuntimeError("Failed to read frame from webcam")
        ok, buf = cv2.imencode(".jpg", frame)
        if not ok:
            raise RuntimeError("Failed to encode frame as JPEG")
        return buf.tobytes()
    finally:
        cap.release()


def resize_and_encode(image_bytes: bytes) -> str:
    img = Image.open(BytesIO(image_bytes)).convert("RGB")
    w, h = img.size
    long_side = max(w, h)
    if long_side > config.MAX_LONG_SIDE:
        scale = config.MAX_LONG_SIDE / long_side
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def analyze_frame(b64_image: str, rule: str, zones: dict | None = None) -> dict:
    prompt = (
        f"Rule: {rule}. "
        "Does this frame violate the rule? "
        'Respond ONLY with JSON: {"triggered": true or false, '
        '"explanation": "one sentence", "confidence": 0.0 to 1.0, '
        '"bbox": [x1,y1,x2,y2] or null (normalised 0-1 coordinates of the '
        "relevant person/object, or null if none)}"
    )
    if zones:
        zone_desc = "; ".join(f"{name}: polygon points {points}" for name, points in zones.items())
        prompt += (
            " The following named zones are defined on this frame (normalised 0-1 coordinates): "
            f"{zone_desc}. If a person or object is detected inside any zone, mention the zone "
            "name in your explanation and set triggered to true."
        )
    payload = {
        "model": config.MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"},
                    },
                    {"type": "text", "text": prompt},
                ],
            }
        ],
    }
    headers = {
        "Authorization": f"Bearer {config.DASHSCOPE_API_KEY}",
        "Content-Type": "application/json",
    }
    try:
        resp = requests.post(
            f"{config.API_BASE_URL}/chat/completions",
            headers=headers,
            json=payload,
            timeout=30,
        )
    except requests.exceptions.SSLError:
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        resp = requests.post(
            f"{config.API_BASE_URL}/chat/completions",
            headers=headers,
            json=payload,
            timeout=30,
            verify=False,
        )
    resp.raise_for_status()
    raw = resp.json()["choices"][0]["message"]["content"]
    result = parse_response(raw)

    zone_name = None
    bbox = result.get("bbox")
    if zones and bbox and len(bbox) == 4:
        x1, y1, x2, y2 = bbox
        center = ((x1 + x2) / 2, (y1 + y2) / 2)
        for name, points in zones.items():
            if point_in_polygon(center, points):
                zone_name = name
                result["triggered"] = True
                explanation = result.get("explanation", "").rstrip(".")
                result["explanation"] = f"{explanation} (inside zone '{name}')."
                break
    result["zone"] = zone_name
    return result


def parse_response(raw: str) -> dict:
    # Strip markdown code fences if present
    cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()
    return json.loads(cleaned)


class DetectorThread(threading.Thread):
    """Background loop: capture → analyze → alert. Results land in a thread-safe queue."""

    def __init__(self, rule: str):
        super().__init__(daemon=True)
        self.rule = rule
        self.queue: Queue = Queue()
        self._active = threading.Event()
        self._active.set()
        self._alerts = deque(maxlen=10)
        self._lock = threading.Lock()
        Path(config.ALERTS_DIR).mkdir(exist_ok=True)

    def stop(self):
        self._active.clear()

    def is_active(self) -> bool:
        return self._active.is_set()

    def get_alerts(self) -> list:
        with self._lock:
            return list(self._alerts)

    def run(self):
        while self._active.is_set():
            try:
                raw_bytes = fetch_frame()
                b64 = resize_and_encode(raw_bytes)
                zones = zones_store.get_zones()
                result = analyze_frame(b64, self.rule, zones)

                triggered = result.get("triggered", False)
                explanation = result.get("explanation", "")
                confidence = round(float(result.get("confidence", 0.0)), 2)
                zone_name = result.get("zone")

                if triggered:
                    ts = datetime.now()
                    filename = f"{ts.strftime('%Y%m%d_%H%M%S_%f')}.jpg"
                    (Path(config.ALERTS_DIR) / filename).write_bytes(raw_bytes)

                    alert = {
                        "id": filename,
                        "timestamp": ts.isoformat(timespec="seconds"),
                        "rule": self.rule,
                        "explanation": explanation,
                        "confidence": confidence,
                        "thumbnail": f"/alerts/{filename}",
                        "zone": zone_name,
                    }
                    with self._lock:
                        self._alerts.appendleft(alert)
                    self.queue.put(alert)
            except Exception as exc:
                self.queue.put({"error": str(exc)})

            for _ in range(config.POLL_INTERVAL * 10):
                if not self._active.is_set():
                    break
                time.sleep(0.1)
