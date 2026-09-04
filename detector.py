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
from PIL import Image, ImageDraw

import config
import incident_log
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


def _normalize_bbox(bbox: list) -> list | None:
    """The model is asked for normalised 0-1 bbox coords but sometimes returns
    values on Qwen-VL's own bbox grounding convention instead: a fixed 0-1000
    scale, independent of the actual served image's pixel dimensions. Confirmed
    directly against raw API output (e.g. a 355x324 crop returning bbox
    [247, 312, 500, 996] — 500 and 996 both exceed the crop's own width/height,
    so these cannot be pixel coordinates; dividing by 1000 gives the correct
    [0.247, 0.312, 0.5, 0.996]). Rescaling by the image's actual pixel
    dimensions instead (the previous approach) silently produced coordinates
    that could exceed 1.0 — most visibly on small zone crops, where it broke
    zone-suppression by placing every bbox centre outside the zone."""
    if not bbox or len(bbox) != 4:
        return bbox
    x1, y1, x2, y2 = bbox
    if max(x1, y1, x2, y2) <= 1.5:
        return bbox  # already normalised (small overshoot tolerance)
    return [x1 / 1000, y1 / 1000, x2 / 1000, y2 / 1000]


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


def _encode_image(img: Image.Image) -> str:
    w, h = img.size
    long_side = max(w, h)
    if long_side > config.MAX_LONG_SIDE:
        scale = config.MAX_LONG_SIDE / long_side
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def resize_and_encode(image_bytes: bytes) -> str:
    img = Image.open(BytesIO(image_bytes)).convert("RGB")
    return _encode_image(img)


def _crop_to_zone(img: Image.Image, zone_points: list):
    """Crops to the bounding rectangle of the zone polygon (in pixel space).
    Returns (cropped_image, crop_rect_norm) where crop_rect_norm is the crop's
    (x1,y1,x2,y2) in full-frame normalised 0-1 coordinates, used later to map
    a bbox the model returns (relative to the crop) back to full-frame space."""
    w, h = img.size
    xs = [p[0] * w for p in zone_points]
    ys = [p[1] * h for p in zone_points]
    x1, x2 = max(0, min(xs)), min(w, max(xs))
    y1, y2 = max(0, min(ys)), min(h, max(ys))
    x1i, y1i = int(x1), int(y1)
    x2i, y2i = max(x1i + 1, int(x2)), max(y1i + 1, int(y2))
    cropped = img.crop((x1i, y1i, x2i, y2i))
    crop_rect_norm = (x1i / w, y1i / h, x2i / w, y2i / h)
    return cropped, crop_rect_norm


def _draw_zone_overlay(
    raw_bytes: bytes,
    zone_points: list | None,
    subject_bbox: list | None = None,
    hazard_bbox: list | None = None,
) -> bytes:
    """Draws the zone polygon (if any) and, for proximity alerts, both bounding
    boxes plus a line connecting their centres, onto the FULL frame for the
    saved evidence image."""
    img = Image.open(BytesIO(raw_bytes)).convert("RGB")
    w, h = img.size
    draw = ImageDraw.Draw(img)

    if zone_points:
        pts = [(p[0] * w, p[1] * h) for p in zone_points]
        draw.line(pts + [pts[0]], fill=(245, 158, 11), width=4)

    centers = []
    for bbox, color in ((subject_bbox, (37, 99, 235)), (hazard_bbox, (220, 38, 38))):
        if bbox and len(bbox) == 4:
            x1, y1, x2, y2 = bbox
            px = (x1 * w, y1 * h, x2 * w, y2 * h)
            draw.rectangle(px, outline=color, width=4)
            centers.append(((px[0] + px[2]) / 2, (px[1] + px[3]) / 2))
    if len(centers) == 2:
        draw.line(centers, fill=(220, 38, 38), width=3)

    buf = BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def _build_ppe_prompt(required_ppe: list, zone_name: str | None) -> str:
    items_desc = ", ".join(required_ppe)
    zone_prefix = (
        f"You are looking at a cropped image showing ONLY the contents of a "
        f"monitored zone called '{zone_name}'. Ignore anything outside this zone. "
        if zone_name else ""
    )
    return (
        f"{zone_prefix}Look at this image. First determine if a person is visible. "
        "If no person is visible, respond with person_present false. If a person is "
        "visible, examine what protective equipment they are wearing. For each of "
        "these required items, state whether it is clearly visible on the person, "
        f"clearly absent, or not determinable from this camera angle: {items_desc}. "
        'Respond ONLY with JSON: {"person_present": true or false, "items": '
        '[{"name": string, "status": "present" or "missing" or "not_visible"}], '
        '"triggered": true or false, "explanation": string, "confidence": 0.0 to 1.0, '
        '"bbox": [x1,y1,x2,y2] or null}. Set triggered to true only if at least one '
        "required item has status missing. Do not set triggered true for items with "
        "status not_visible."
    )


def _build_proximity_prompt(subject: str, hazard: str, zone_name: str | None) -> str:
    zone_prefix = (
        f"You are looking at a cropped image showing ONLY the contents of a "
        f"monitored zone called '{zone_name}'. Ignore anything outside this zone. "
        if zone_name else ""
    )
    return (
        f"{zone_prefix}Look at this image. Determine whether {subject} and {hazard} are "
        "both visible, and if so how close they are to each other. Respond ONLY with JSON: "
        '{"subject_present": true or false, "hazard_present": true or false, "proximity": '
        '"touching" or "very_close" or "nearby" or "far" or "not_applicable", '
        '"triggered": true or false, "explanation": string describing the spatial '
        'relationship, "confidence": 0.0 to 1.0, "subject_bbox": [x1,y1,x2,y2] or null, '
        '"hazard_bbox": [x1,y1,x2,y2] or null}. Set proximity to not_applicable if either '
        "object is missing. Set triggered true only when proximity is touching or very_close."
    )


def analyze_frame(
    raw_bytes: bytes,
    rule_text: str,
    zone_name: str | None = None,
    rule_type: str = "standard",
    required_ppe: list | None = None,
    subject: str | None = None,
    hazard: str | None = None,
) -> dict:
    """Evaluates a single rule against a frame. If zone_name is given, the rule
    is scoped to that zone's polygon only (looked up fresh from zones_store):
    the image sent to the model is CROPPED to the zone's bounding rectangle so
    it cannot see or describe anything outside it."""
    zone_points = zones_store.get_zones().get(zone_name) if zone_name else None
    crop_rect_norm = None

    if zone_points:
        img = Image.open(BytesIO(raw_bytes)).convert("RGB")
        cropped_img, crop_rect_norm = _crop_to_zone(img, zone_points)
        b64_image = _encode_image(cropped_img)
    else:
        b64_image = resize_and_encode(raw_bytes)

    if rule_type == "ppe_check":
        prompt = _build_ppe_prompt(required_ppe or [], zone_name if zone_points else None)
    elif rule_type == "proximity":
        prompt = _build_proximity_prompt(subject or "", hazard or "", zone_name if zone_points else None)
    elif zone_points:
        prompt = (
            f"You are looking at a cropped image showing ONLY the contents of a "
            f"monitored zone called '{zone_name}'. Ignore anything outside this zone. "
            f"Rule: {rule_text}. Does this cropped zone image violate the rule? "
            'Respond ONLY with JSON: {"triggered": true or false, '
            '"explanation": "one sentence about what you see INSIDE THIS ZONE ONLY", '
            '"confidence": 0.0 to 1.0, "bbox": [x1,y1,x2,y2] or null}'
        )
    else:
        prompt = (
            f"Rule: {rule_text}. "
            "Does this frame violate the rule? "
            'Respond ONLY with JSON: {"triggered": true or false, '
            '"explanation": "one sentence", "confidence": 0.0 to 1.0, '
            '"bbox": [x1,y1,x2,y2] or null (normalised 0-1 coordinates of the '
            "relevant person/object, or null if none)}"
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

    if rule_type == "ppe_check" and not result.get("person_present", True):
        # no person in frame — never alert on PPE regardless of what the model
        # put in "items" or "triggered"
        triggered = False

    position_unverified = False

    def _map_back(box):
        if box and crop_rect_norm:
            cx1, cy1, cx2, cy2 = crop_rect_norm
            bx1, by1, bx2, by2 = box
            return [
                cx1 + bx1 * (cx2 - cx1),
                cy1 + by1 * (cy2 - cy1),
                cx1 + bx2 * (cx2 - cx1),
                cy1 + by2 * (cy2 - cy1),
            ]
        return box

    if rule_type == "proximity":
        subject_bbox = _map_back(_normalize_bbox(result.get("subject_bbox")))
        hazard_bbox = _map_back(_normalize_bbox(result.get("hazard_bbox")))

        if triggered and subject_bbox and hazard_bbox and len(subject_bbox) == 4 and len(hazard_bbox) == 4:
            sx = (subject_bbox[0] + subject_bbox[2]) / 2
            sy = (subject_bbox[1] + subject_bbox[3]) / 2
            hx = (hazard_bbox[0] + hazard_bbox[2]) / 2
            hy = (hazard_bbox[1] + hazard_bbox[3]) / 2
            dist = ((sx - hx) ** 2 + (sy - hy) ** 2) ** 0.5
            frame_diagonal = 2 ** 0.5  # normalised 0-1 axes, diagonal of the unit square
            if dist > 0.4 * frame_diagonal:
                print("proximity overridden — objects too far apart geometrically")
                triggered = False
            else:
                print(f"Rule '{rule_text}' — triggered — proximity='{result.get('proximity')}' — alert created")
        elif triggered:
            # triggered=true but missing a bbox to verify geometrically — trust
            # the model, but flag the alert as unverified (same pattern as zones)
            position_unverified = True
            print(f"Rule '{rule_text}' — triggered — no bbox pair to verify — position unverified — alert created")
        else:
            print(f"Rule '{rule_text}' — not triggered — skipped")

        result["subject_bbox"] = subject_bbox
        result["hazard_bbox"] = hazard_bbox
    else:
        bbox = _map_back(_normalize_bbox(result.get("bbox")))

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


def _evaluate_rule(
    rule_text: str,
    zone_name: str | None,
    raw_bytes: bytes,
    rule_type: str = "standard",
    required_ppe: list | None = None,
    subject: str | None = None,
    hazard: str | None = None,
) -> dict:
    """Runs in a worker thread — logs start/finish with millisecond timestamps
    so overlapping runs are visible in the terminal as proof of parallelism."""
    start_label = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    zone_label = f" zone='{zone_name}'" if zone_name else ""
    print(f"[{start_label}] START  rule='{rule_text}'{zone_label}")
    result = analyze_frame(
        raw_bytes, rule_text, zone_name,
        rule_type=rule_type, required_ppe=required_ppe, subject=subject, hazard=hazard,
    )
    finish_label = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    print(f"[{finish_label}] FINISH rule='{rule_text}'{zone_label} triggered={result.get('triggered')}")
    return result


def build_alert(rule_entry: dict, result: dict, filename: str, ts: datetime) -> dict:
    """Assembles the alert record stored/returned for a triggered rule — shared
    by the live DetectorThread and the one-shot DemoRunThread so rule-type-
    specific fields (ppe_check 'items', proximity bboxes) are handled once."""
    alert = {
        "id": filename,
        "timestamp": ts.isoformat(timespec="seconds"),
        "rule": rule_entry["rule_text"],
        "explanation": result.get("explanation", ""),
        "confidence": round(float(result.get("confidence", 0.0)), 2),
        "thumbnail": f"/alerts/{filename}",
        "zone": result.get("zone"),
        "position_unverified": result.get("position_unverified", False),
        "rule_type": rule_entry.get("rule_type", "standard"),
    }
    if rule_entry.get("rule_type") == "ppe_check":
        alert["items"] = result.get("items", [])
    elif rule_entry.get("rule_type") == "proximity":
        alert["proximity"] = result.get("proximity")
        alert["subject_bbox"] = result.get("subject_bbox")
        alert["hazard_bbox"] = result.get("hazard_bbox")
    alert["severity"] = incident_log.classify_severity(
        alert["rule"], alert["explanation"], alert["confidence"],
        alert["rule_type"], alert.get("proximity"),
    )
    return alert


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
                        max_workers = min(len(enabled_rules), config.MAX_PARALLEL_RULES)
                        with ThreadPoolExecutor(max_workers=max_workers) as executor:
                            futures = {
                                executor.submit(
                                    _evaluate_rule, r["rule_text"], r.get("zone_name"), raw_bytes,
                                    r.get("rule_type", "standard"), r.get("required_ppe"),
                                    r.get("subject"), r.get("hazard"),
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
                                    ts = datetime.now()
                                    filename = f"{ts.strftime('%Y%m%d_%H%M%S_%f')}.jpg"

                                    # evidence is always the FULL frame — with the zone
                                    # polygon and/or proximity bboxes drawn on it
                                    zone_name = rule_entry.get("zone_name")
                                    zone_points = zones_store.get_zones().get(zone_name) if zone_name else None
                                    is_proximity = rule_entry.get("rule_type") == "proximity"
                                    subject_bbox = result.get("subject_bbox") if is_proximity else None
                                    hazard_bbox = result.get("hazard_bbox") if is_proximity else None
                                    evidence_bytes = (
                                        _draw_zone_overlay(raw_bytes, zone_points, subject_bbox, hazard_bbox)
                                        if (zone_points or subject_bbox or hazard_bbox) else raw_bytes
                                    )
                                    (Path(config.ALERTS_DIR) / filename).write_bytes(evidence_bytes)

                                    alert = build_alert(rule_entry, result, filename, ts)
                                    incident_log.log_incident(alert)
                                    with self._lock:
                                        self._alerts.appendleft(alert)
                                    self.queue.put(alert)
            except Exception as exc:
                self.queue.put({"error": str(exc)})

            for _ in range(config.POLL_INTERVAL * 10):
                if not self._active.is_set():
                    break
                time.sleep(0.1)
