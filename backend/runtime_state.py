"""Shared in-memory runtime state for the monitoring loop.

Tracks whether monitoring is active, the selected demo video path and other
volatile state that is not persisted to disk.
"""

import threading

from . import config

# Lock protects all mutable global state in this module.
_lock = threading.Lock()
# True when the detector should analyse a demo video instead of the live camera.
_demo_mode = config.DEMO_MODE
# Path to the uploaded/demo video currently selected by the user.
_video_path = config.DEMO_VIDEO_PATH or None


def get_demo_mode() -> bool:
    """Return whether the application is running in demo/upload mode."""
    with _lock:
        return _demo_mode


def set_demo_mode(value: bool):
    """Switch between live camera and demo/upload mode."""
    global _demo_mode
    with _lock:
        _demo_mode = bool(value)


def get_video_path():
    """Return the currently selected demo video path, or None."""
    with _lock:
        return _video_path


def set_video_path(path):
    """Set the demo video path that the detector will read from."""
    global _video_path
    with _lock:
        _video_path = path
