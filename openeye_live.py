import base64
import json
import os
import re
import signal
import time
from datetime import datetime
from io import BytesIO

import cv2
import requests
import urllib3
from dotenv import load_dotenv
from PIL import Image

load_dotenv()

# ── Configuration ─────────────────────────────────────────────────────────────
CAMERA_INDEX = int(os.environ.get("CAMERA_INDEX", "0"))
API_BASE_URL = os.environ["API_BASE_URL"]
API_KEY = os.environ["API_KEY"]
MODEL = "qwen-vl-max"

RULE = "Is a person touching or moving a Rubik's cube?"

POLL_INTERVAL = 2       # seconds between frames
MAX_LONG_SIDE = 1280    # resize threshold in pixels
ALERTS_DIR = "alerts"
CAMERA_WARMUP_FRAMES = 10  # discard frames while auto-exposure settles
# ──────────────────────────────────────────────────────────────────────────────

_running = True


def handle_exit(sig, frame):
    global _running
    print("\nStopping OpenEye...")
    _running = False


signal.signal(signal.SIGINT, handle_exit)
signal.signal(signal.SIGTERM, handle_exit)


def fetch_frame() -> bytes:
    cap = cv2.VideoCapture(CAMERA_INDEX)
    try:
        if not cap.isOpened():
            raise Exception("Cannot open webcam")
        frame = None
        for _ in range(CAMERA_WARMUP_FRAMES):
            ok, frame = cap.read()
            if not ok:
                raise Exception("Failed to read frame from webcam")
            time.sleep(0.1)
        ok, buf = cv2.imencode(".jpg", frame)
        if not ok:
            raise Exception("Failed to encode frame as JPEG")
        return buf.tobytes()
    finally:
        cap.release()


def resize_and_encode(image_bytes: bytes) -> str:
    img = Image.open(BytesIO(image_bytes)).convert("RGB")
    w, h = img.size
    long_side = max(w, h)
    if long_side > MAX_LONG_SIDE:
        scale = MAX_LONG_SIDE / long_side
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def analyze_frame(b64_image: str, rule: str) -> dict:
    prompt = (
        f"Rule: {rule}. "
        'Does this frame violate the rule? '
        'Respond ONLY with JSON: {"triggered": true or false, '
        '"explanation": "one sentence", "confidence": 0.0 to 1.0}'
    )
    payload = {
        "model": MODEL,
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
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    try:
        resp = requests.post(
            f"{API_BASE_URL}/chat/completions",
            headers=headers,
            json=payload,
            timeout=30,
        )
    except requests.exceptions.SSLError:
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        resp = requests.post(
            f"{API_BASE_URL}/chat/completions",
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


def save_alert(image_bytes: bytes, timestamp: str) -> str:
    os.makedirs(ALERTS_DIR, exist_ok=True)
    filename = os.path.join(ALERTS_DIR, f"{timestamp}.jpg")
    with open(filename, "wb") as f:
        f.write(image_bytes)
    return filename


def main():
    print(f"OpenEye started — rule: {RULE}")
    print(f"Camera index: {CAMERA_INDEX}")
    print(f"Press Ctrl+C to stop.\n")

    while _running:
        ts = datetime.now().strftime("%H:%M:%S")
        try:
            raw_bytes = fetch_frame()
            b64 = resize_and_encode(raw_bytes)
            result = analyze_frame(b64, RULE)

            triggered = result.get("triggered", False)
            explanation = result.get("explanation", "")
            confidence = result.get("confidence", 0.0)

            if triggered:
                file_ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
                saved = save_alert(raw_bytes, file_ts)
                print(f"[{ts}] ALERT: {explanation} (confidence={confidence:.2f}) → {saved}")
            else:
                print(f"[{ts}] clear (confidence={confidence:.2f})")

        except requests.exceptions.ConnectionError:
            print(f"[{ts}] ERROR: Cannot reach API")
        except requests.exceptions.Timeout:
            print(f"[{ts}] ERROR: Request timed out")
        except requests.exceptions.HTTPError as e:
            print(f"[{ts}] ERROR: HTTP {e.response.status_code} — {e.response.text[:200]}")
        except json.JSONDecodeError as e:
            print(f"[{ts}] ERROR: Failed to parse model response — {e}")
        except Exception as e:
            print(f"[{ts}] ERROR: {type(e).__name__}: {e}")

        # Sleep in small increments so Ctrl+C is responsive
        for _ in range(POLL_INTERVAL * 10):
            if not _running:
                break
            time.sleep(0.1)

    print("OpenEye stopped.")


if __name__ == "__main__":
    main()
