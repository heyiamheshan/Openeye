import threading

import config

_lock = threading.Lock()
_demo_mode = config.DEMO_MODE
_video_path = config.DEMO_VIDEO_PATH or None


def get_demo_mode() -> bool:
    with _lock:
        return _demo_mode


def set_demo_mode(value: bool):
    global _demo_mode
    with _lock:
        _demo_mode = bool(value)


def get_video_path():
    with _lock:
        return _video_path


def set_video_path(path):
    global _video_path
    with _lock:
        _video_path = path
