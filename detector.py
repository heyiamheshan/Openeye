import base64
import json
import re
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from io import BytesIO
from pathlib import Path
from queue import Queue

import cv2
import numpy as np
import requests
import urllib3
from PIL import Image

import config
import rules_store
import runtime_state
import zones_store


def _motion_score(prev_bytes: bytes, curr_bytes: bytes) -> float:
    """Mean absolute pixel difference (grayscale) between two JPEG-encoded frames."""
    prev_arr = cv2.imdecode(np.frombuffer(prev_bytes, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    curr_arr = cv2.imdecode(np.frombuffer(curr_bytes, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if prev_arr is None or curr_arr is None or prev_arr.shape != curr_arr.shape:
        return float("inf")  # can't compare — treat as motion so we don't get stuck skipping
    return float(cv2.absdiff(prev_arr, curr_arr).mean())

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


def _normalize_bbox(bbox: list, b64_image: str) -> list | None:
    """The model is asked for normalised 0-1 bbox coords but sometimes returns
    pixel coordinates instead. Detect that and rescale using the actual decoded
    image dimensions, so the zone polygon check (also normalised 0-1) is valid."""
    if not bbox or len(bbox) != 4:
        return bbox
    x1, y1, x2, y2 = bbox
    if max(x1, y1, x2, y2) <= 1.5:
        return bbox  # already normalised (small overshoot tolerance)
    try:
        img = Image.open(BytesIO(base64.b64decode(b64_image)))
        w, h = img.size
        if w == 0 or h == 0:
            return None
        return [x1 / w, y1 / h, x2 / w, y2 / h]
    except Exception:
        return None  # can't verify — treat as unavailable, not as "outside"


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


def analyze_frame(b64_image: str, rule_text: str, zone_name: str | None = None) -> dict:
    """Evaluates a single rule against a frame. If zone_name is given, the rule
    is scoped to that zone's polygon only (looked up fresh from zones_store) —
    activity elsewhere in the frame should not trigger it."""
    zone_points = zones_store.get_zones().get(zone_name) if zone_name else None

    prompt = (
        f"Rule: {rule_text}. "
        "Does this frame violate the rule? "
        'Respond ONLY with JSON: {"triggered": true or false, '
        '"explanation": "one sentence", "confidence": 0.0 to 1.0, '
        '"bbox": [x1,y1,x2,y2] or null (normalised 0-1 coordinates of the '
        "relevant person/object, or null if none)}"
    )
    if zone_points:
        prompt += (
            f" This rule applies only to the zone '{zone_name}', defined by polygon "
            f"points {zone_points} (normalised 0-1 coordinates). Only consider "
            "activity inside this zone when deciding whether to trigger; ignore "
            "activity elsewhere in the frame."
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

    triggered = result.get("triggered", False)
    bbox = _normalize_bbox(result.get("bbox"), b64_image)
    position_unverified = False

    if not triggered:
        print(f"Rule '{rule_text}' — not triggered — skipped")
    elif zone_points:
        if bbox and len(bbox) == 4:
            x1, y1, x2, y2 = bbox
            center = ((x1 + x2) / 2, (y1 + y2) / 2)
            cx, cy = round(center[0], 3), round(center[1], 3)
            if point_in_polygon(center, zone_points):
                print(
                    f"Rule '{rule_text}' — triggered in zone '{zone_name}' — "
                    f"bbox centre [{cx},{cy}] — INSIDE zone — alert created"
                )
            else:
                print(
                    f"Rule '{rule_text}' — triggered in zone '{zone_name}' — "
                    f"bbox centre [{cx},{cy}] — OUTSIDE zone — alert suppressed"
                )
                triggered = False
        else:
            # triggered=true but no bbox to verify against the zone geometrically —
            # trust the model, but flag the alert as unverified
            position_unverified = True
            print(
                f"Rule '{rule_text}' — triggered in zone '{zone_name}' — "
                "no bbox returned — position unverified — alert created"
            )
    else:
        print(f"Rule '{rule_text}' — triggered — whole frame rule — alert created")

    result["triggered"] = triggered
    result["zone"] = zone_name
    result["position_unverified"] = position_unverified
    return result


def parse_response(raw: str) -> dict:
    # Strip markdown code fences if present
    cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()
    return json.loads(cleaned)


def _evaluate_rule(rule_text: str, zone_name: str | None, b64_image: str) -> dict:
    """Runs in a worker thread — logs start/finish with millisecond timestamps
    so overlapping runs are visible in the terminal as proof of parallelism."""
    start_label = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    zone_label = f" zone='{zone_name}'" if zone_name else ""
    print(f"[{start_label}] START  rule='{rule_text}'{zone_label}")
    result = analyze_frame(b64_image, rule_text, zone_name)
    finish_label = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    print(f"[{finish_label}] FINISH rule='{rule_text}'{zone_label} triggered={result.get('triggered')}")
    return result


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
        self._prev_frame_bytes = None
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

                # motion gate — skip the API call entirely if nothing changed
                motion_ok = True
                if self._prev_frame_bytes is not None:
                    score = _motion_score(self._prev_frame_bytes, raw_bytes)
                    motion_ok = score >= config.MOTION_THRESHOLD
                self._prev_frame_bytes = raw_bytes

                if not motion_ok:
                    print("no motion — skipped")
                else:
                    enabled_rules = rules_store.get_enabled_rules()
                    if not enabled_rules and self.rule:
                        # fallback: no multi-rule list configured, use the single
                        # rule this thread was started with (existing behaviour)
                        enabled_rules = [{"id": None, "rule_text": self.rule, "zone_name": None}]

                    if enabled_rules:
                        b64 = resize_and_encode(raw_bytes)

                        # save the evidence frame once — every rule that fires
                        # this cycle shares the same saved frame path
                        ts = datetime.now()
                        filename = f"{ts.strftime('%Y%m%d_%H%M%S_%f')}.jpg"
                        (Path(config.ALERTS_DIR) / filename).write_bytes(raw_bytes)

                        max_workers = min(len(enabled_rules), config.MAX_PARALLEL_RULES)
                        with ThreadPoolExecutor(max_workers=max_workers) as executor:
                            futures = {
                                executor.submit(
                                    _evaluate_rule, r["rule_text"], r.get("zone_name"), b64
                                ): r
                                for r in enabled_rules
                            }
                            for future in as_completed(futures):
                                rule_entry = futures[future]
                                try:
                                    result = future.result()
                                except Exception as exc:
                                    print(f"rule '{rule_entry['rule_text']}' ERROR: {exc}")
                                    continue

                                if result.get("triggered", False):
                                    alert = {
                                        "id": filename,
                                        "timestamp": ts.isoformat(timespec="seconds"),
                                        "rule": rule_entry["rule_text"],
                                        "explanation": result.get("explanation", ""),
                                        "confidence": round(float(result.get("confidence", 0.0)), 2),
                                        "thumbnail": f"/alerts/{filename}",
                                        "zone": result.get("zone"),
                                        "position_unverified": result.get("position_unverified", False),
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
