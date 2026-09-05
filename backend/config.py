"""Environment configuration and project paths.

Loads .env values and exposes BASE_DIR so every backend module can resolve
files relative to the project root regardless of the working directory.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# Resolve the project root from this file's location (backend/config.py).
# All runtime data paths are resolved relative to this directory.
BASE_DIR = Path(__file__).resolve().parent.parent

# Load environment variables from the .env file at the project root.
load_dotenv(BASE_DIR / ".env")

# --- DashScope / Alibaba Cloud Model Studio credentials --------------------
DASHSCOPE_API_KEY = os.environ.get("DASHSCOPE_API_KEY", "")
API_BASE_URL = os.environ.get("API_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")

# --- Live camera settings --------------------------------------------------
CAMERA_INDEX = int(os.environ.get("CAMERA_INDEX", "0"))       # Default to the first webcam.
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "3"))     # Seconds between analysis frames.

# --- Vision-Language model configuration -----------------------------------
MODEL = os.environ.get("VL_MODEL", "qwen3-vl-235b-a22b-instruct")  # Model that analyses frames.
TEXT_MODEL = os.environ.get("TEXT_MODEL", "qwen-plus")             # Model that refines rules.
MAX_LONG_SIDE = int(os.environ.get("MAX_LONG_SIDE", "1280"))       # Largest image dimension sent to VLM.
CAMERA_WARMUP_FRAMES = int(os.environ.get("CAMERA_WARMUP_FRAMES", "5"))
ALERTS_DIR = os.environ.get("ALERTS_DIR", str(BASE_DIR / "alerts"))  # Where alert snapshots are saved.

# --- Detection tuning ------------------------------------------------------
MOTION_THRESHOLD = float(os.environ.get("MOTION_THRESHOLD", "8.0"))  # Skip frames with less motion.
MAX_PARALLEL_RULES = int(os.environ.get("MAX_PARALLEL_RULES", "4"))  # Concurrent VLM rule checks.

# --- Demo / upload mode ----------------------------------------------------
DEMO_MODE = os.environ.get("DEMO_MODE", "false").strip().lower() == "true"
DEMO_VIDEO_PATH = os.environ.get("DEMO_VIDEO_PATH", "")
UPLOADS_DIR = os.environ.get("UPLOADS_DIR", str(BASE_DIR / "uploads"))

# --- Telegram escalation ---------------------------------------------------
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
ESCALATION_ENABLED = os.environ.get("ESCALATION_ENABLED", "true").strip().lower() == "true"
ESCALATION_COOLDOWN_SECONDS = int(os.environ.get("ESCALATION_COOLDOWN_SECONDS", "60"))
