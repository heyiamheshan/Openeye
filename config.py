import os

from dotenv import load_dotenv

load_dotenv()

DASHSCOPE_API_KEY = os.environ.get("DASHSCOPE_API_KEY", "")
API_BASE_URL = os.environ.get("API_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
CAMERA_INDEX = int(os.environ.get("CAMERA_INDEX", "0"))
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "3"))

MODEL = os.environ.get("VL_MODEL", "qwen3-vl-plus-2025-12-19")
MAX_LONG_SIDE = int(os.environ.get("MAX_LONG_SIDE", "1280"))
CAMERA_WARMUP_FRAMES = int(os.environ.get("CAMERA_WARMUP_FRAMES", "5"))
ALERTS_DIR = os.environ.get("ALERTS_DIR", "alerts")

MOTION_THRESHOLD = float(os.environ.get("MOTION_THRESHOLD", "8.0"))
MAX_PARALLEL_RULES = int(os.environ.get("MAX_PARALLEL_RULES", "4"))

DEMO_MODE = os.environ.get("DEMO_MODE", "false").strip().lower() == "true"
DEMO_VIDEO_PATH = os.environ.get("DEMO_VIDEO_PATH", "")
UPLOADS_DIR = os.environ.get("UPLOADS_DIR", "uploads")
