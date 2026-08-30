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


def fetch_frame() -> bytes:
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


def analyze_frame(b64_image: str, rule: str) -> dict:
    prompt = (
        f"Rule: {rule}. "
        "Does this frame violate the rule? "
        'Respond ONLY with JSON: {"triggered": true or false, '
        '"explanation": "one sentence", "confidence": 0.0 to 1.0}'
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
    return parse_response(raw)


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
                result = analyze_frame(b64, self.rule)

                triggered = result.get("triggered", False)
                explanation = result.get("explanation", "")
                confidence = round(float(result.get("confidence", 0.0)), 2)

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
