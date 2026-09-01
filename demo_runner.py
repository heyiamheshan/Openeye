import threading
from datetime import datetime
from pathlib import Path

import cv2

import config
import zones_store
from detector import analyze_frame, resize_and_encode

TARGET_FRAMES = 30
MAX_FRAMES = 40


def compute_sample_indices(frame_count: int) -> list:
    if frame_count <= 0:
        return []
    if frame_count <= TARGET_FRAMES:
        indices = list(range(frame_count))
    else:
        step = max(1, frame_count // TARGET_FRAMES)
        indices = list(range(0, frame_count, step))
    return indices[:MAX_FRAMES]


class DemoRunThread(threading.Thread):
    """One-shot: samples ~30 frames from a video and analyses each against the rule."""

    def __init__(self, rule: str, video_path: str):
        super().__init__(daemon=True)
        self.rule = rule
        self.video_path = video_path
        self.total = 0
        self.current_index = 0  # 1-based count of frames processed so far
        self.done = False
        self.cancelled = False
        self.error = None
        self._alerts = []
        self._current_frame = None  # jpeg bytes of the frame currently displayed
        self._lock = threading.Lock()
        Path(config.ALERTS_DIR).mkdir(exist_ok=True)

    def cancel(self):
        self.cancelled = True

    def get_status(self) -> dict:
        with self._lock:
            return {
                "current_index": self.current_index,
                "total": self.total,
                "done": self.done,
                "cancelled": self.cancelled,
                "error": self.error,
                "alerts": list(self._alerts),
            }

    def get_current_frame(self):
        with self._lock:
            return self._current_frame

    def run(self):
        cap = cv2.VideoCapture(self.video_path)
        try:
            if not cap.isOpened():
                with self._lock:
                    self.error = f"Cannot open video: {self.video_path}"
                    self.done = True
                return

            frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            indices = compute_sample_indices(frame_count)
            with self._lock:
                self.total = len(indices)

            zones = zones_store.get_zones()

            for i, idx in enumerate(indices, start=1):
                if self.cancelled:
                    break

                cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
                ok, frame = cap.read()
                if not ok:
                    continue

                ok2, buf = cv2.imencode(".jpg", frame)
                if not ok2:
                    continue
                raw_bytes = buf.tobytes()

                with self._lock:
                    self._current_frame = raw_bytes
                    self.current_index = i

                try:
                    b64 = resize_and_encode(raw_bytes)
                    result = analyze_frame(b64, self.rule, zones)
                except Exception as exc:
                    with self._lock:
                        self.error = str(exc)
                    continue

                if result.get("triggered", False):
                    ts = datetime.now()
                    filename = f"{ts.strftime('%Y%m%d_%H%M%S_%f')}.jpg"
                    (Path(config.ALERTS_DIR) / filename).write_bytes(raw_bytes)
                    alert = {
                        "id": filename,
                        "timestamp": ts.isoformat(timespec="seconds"),
                        "rule": self.rule,
                        "explanation": result.get("explanation", ""),
                        "confidence": round(float(result.get("confidence", 0.0)), 2),
                        "thumbnail": f"/alerts/{filename}",
                        "zone": result.get("zone"),
                    }
                    with self._lock:
                        self._alerts.append(alert)
        finally:
            cap.release()
            with self._lock:
                self.done = True
