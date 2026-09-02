import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import cv2

import config
import incident_log
import zones_store
from detector import _draw_zone_overlay, _evaluate_rule, build_alert

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
    """One-shot: samples ~30 frames from a video; every enabled rule is evaluated
    against each sampled frame in parallel (same ThreadPoolExecutor pattern as
    live mode's DetectorThread)."""

    def __init__(self, rules: list, video_path: str):
        super().__init__(daemon=True)
        self.rules = rules  # [{id, rule_text, zone_name, enabled}, ...]
        self.video_path = video_path
        self.total = 0
        self.current_index = 0  # 1-based count of frames processed so far
        self.done = False
        self.cancelled = False
        self.error = None
        self._alerts = []
        self._current_frame = None  # jpeg bytes of the frame currently displayed
        self._current_rule_label = ""
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
                "current_rule_label": self._current_rule_label,
                "rule_count": len(self.rules),
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

            rule_label = ", ".join(r["rule_text"] for r in self.rules)

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
                    self._current_rule_label = rule_label

                print(f"[demo frame {i}/{len(indices)}] evaluating {len(self.rules)} rule(s):")
                for r in self.rules:
                    print(
                        f"    rule={r['rule_text']!r} zone={r.get('zone_name')!r} "
                        f"rule_type={r.get('rule_type', 'standard')}"
                    )

                max_workers = min(len(self.rules), config.MAX_PARALLEL_RULES)
                with ThreadPoolExecutor(max_workers=max_workers) as executor:
                    futures = {
                        executor.submit(
                            _evaluate_rule, r["rule_text"], r.get("zone_name"), raw_bytes,
                            r.get("rule_type", "standard"), r.get("required_ppe"),
                            r.get("subject"), r.get("hazard"),
                        ): r
                        for r in self.rules
                    }
                    for future in as_completed(futures):
                        rule_entry = futures[future]
                        try:
                            result = future.result()
                        except Exception as exc:
                            print(f"[demo frame {i}] rule '{rule_entry['rule_text']}' ERROR: {exc}")
                            continue

                        print(
                            f"[demo frame {i}] rule={rule_entry['rule_text']!r} "
                            f"zone={rule_entry.get('zone_name')!r} "
                            f"triggered={result.get('triggered')} "
                            f"confidence={result.get('confidence')} "
                            f"explanation={result.get('explanation')!r}"
                        )

                        if result.get("triggered", False):
                            ts = datetime.now()
                            filename = f"{ts.strftime('%Y%m%d_%H%M%S_%f')}.jpg"

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
                                self._alerts.append(alert)
        finally:
            cap.release()
            with self._lock:
                self.done = True
