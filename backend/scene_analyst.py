"""Scene Intelligence — uses Qwen-VL to analyse a camera frame and propose
monitoring rules grounded in what the model actually observes."""

import base64
import json
import logging
from io import BytesIO

import requests
import urllib3
from PIL import Image

from . import config

log = logging.getLogger(__name__)

# ── prompt ────────────────────────────────────────────────────────────────────

SCENE_PROMPT = """\
You are a workplace safety analyst examining a live camera view. \
Describe what you observe and propose monitoring rules.

Respond ONLY with valid JSON in this exact structure (no markdown, no commentary):
{
  "scene_type": "short description of the environment, e.g. 'warehouse floor' or 'manufacturing bay'",
  "observed": ["list", "of", "specific objects, equipment, people and hazards you can actually see"],
  "suggested_zones": [
    {
      "name": "short zone name",
      "reason": "why this area needs monitoring",
      "approx_bounds": [x1, y1, x2, y2]
    }
  ],
  "suggested_rules": [
    {
      "rule_text": "a state-based monitoring rule phrased as a question or condition",
      "rule_type": "standard" | "proximity" | "ppe_check",
      "subject": "only for proximity rules, otherwise omit",
      "hazard": "only for proximity rules, otherwise omit",
      "required_ppe": ["only", "for", "ppe_check"],
      "zone_name": "the suggested zone this applies to, or null for whole frame",
      "reason": "one sentence explaining why this rule matters for this scene",
      "priority": "high" | "medium" | "low"
    }
  ]
}

Guidelines:
- approx_bounds values are normalised 0-1, where [0,0] is top-left and [1,1] is bottom-right.
- Propose between 4 and 7 rules.
- Only propose rules relevant to what is actually visible.
- Phrase all rules as state descriptions (e.g. "Is a person inside this zone without a hard hat?") \
  NOT event descriptions (e.g. "Person enters zone"), because single-frame analysis cannot detect transitions.
- Do not invent regulations or standards that are not visible in the scene."""

# ── helpers ───────────────────────────────────────────────────────────────────


def _encode_frame(frame_bytes: bytes) -> str:
    """Resize if needed and return base64-encoded JPEG."""
    img = Image.open(BytesIO(frame_bytes)).convert("RGB")
    w, h = img.size
    long_side = max(w, h)
    if long_side > config.MAX_LONG_SIDE:
        scale = config.MAX_LONG_SIDE / long_side
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _call_vlm(b64_image: str) -> dict:
    """Send the image + prompt to the VLM and return parsed JSON."""
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
                    {"type": "text", "text": SCENE_PROMPT},
                ],
            }
        ],
        "response_format": {"type": "json_object"},
    }
    headers = {
        "Authorization": f"Bearer {config.DASHSCOPE_API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        try:
            resp = requests.post(
                f"{config.API_BASE_URL}/chat/completions",
                headers=headers,
                json=payload,
                timeout=60,
            )
        except requests.exceptions.SSLError:
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            resp = requests.post(
                f"{config.API_BASE_URL}/chat/completions",
                headers=headers,
                json=payload,
                timeout=60,
                verify=False,
            )
        resp.raise_for_status()
    except requests.RequestException as exc:
        log.error("VLM request failed: %s", exc)
        raise RuntimeError(f"VLM request failed: {exc}") from exc

    raw = resp.json()["choices"][0]["message"]["content"].strip()

    # Strip markdown fences if the model wraps in ```json ... ```
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        log.error("VLM returned invalid JSON: %s\nRaw: %s", exc, raw[:500])
        raise RuntimeError("VLM returned invalid JSON") from exc


# ── public API ────────────────────────────────────────────────────────────────


def analyse_scene(frame_bytes: bytes) -> dict:
    """Analyse a single camera frame and return structured scene intelligence.

    Parameters
    ----------
    frame_bytes : bytes
        JPEG-encoded image bytes.

    Returns
    -------
    dict with keys: scene_type, observed, suggested_zones, suggested_rules
    """
    b64 = _encode_frame(frame_bytes)
    result = _call_vlm(b64)

    # Normalise: ensure lists exist
    result.setdefault("observed", [])
    result.setdefault("suggested_zones", [])
    result.setdefault("suggested_rules", [])

    # Validate each rule has required fields
    valid_types = {"standard", "proximity", "ppe_check"}
    valid_priorities = {"high", "medium", "low"}
    clean_rules = []
    for r in result["suggested_rules"]:
        if "rule_text" not in r:
            continue
        r["rule_type"] = r.get("rule_type", "standard")
        if r["rule_type"] not in valid_types:
            r["rule_type"] = "standard"
        r["priority"] = r.get("priority", "medium")
        if r["priority"] not in valid_priorities:
            r["priority"] = "medium"
        clean_rules.append(r)
    result["suggested_rules"] = clean_rules

    # Validate zone bounds
    clean_zones = []
    for z in result["suggested_zones"]:
        if "name" not in z or "approx_bounds" not in z:
            continue
        bounds = z["approx_bounds"]
        if not (isinstance(bounds, list) and len(bounds) == 4):
            continue
        # Clamp to 0-1
        z["approx_bounds"] = [max(0.0, min(1.0, float(v))) for v in bounds]
        clean_zones.append(z)
    result["suggested_zones"] = clean_zones

    return result
