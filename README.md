# OpenEye

AI camera monitor: point a webcam at a scene, describe a rule in plain English, and get alerts (with saved frames) whenever the rule is triggered — powered by Qwen-VL.

## Setup

```bash
git clone <this-repo>
cd openeye
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` and fill in your DashScope credentials:

```
DASHSCOPE_API_KEY=sk-your-key-here
API_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
CAMERA_INDEX=0
POLL_INTERVAL=3
VL_MODEL=qwen-vl-max
```

## Run

```bash
python app.py
```

Open [http://localhost:5001](http://localhost:5001) in your browser.

## Usage

1. Type a monitoring rule in plain English (e.g. "Alert me if someone enters the yellow zone").
2. Click **Start Monitoring** — the background detector begins polling the camera every `POLL_INTERVAL` seconds.
3. When the rule is triggered, an alert card appears with a thumbnail, timestamp, explanation, and confidence score. The full frame is saved to `alerts/`.
4. Click **Stop** to pause detection at any time.

## Project layout

```
openeye/
├── app.py          # Flask app, routes, MJPEG feed, alerts endpoint
├── detector.py     # Detection logic: frame capture, VLM call, parser, DetectorThread
├── config.py       # All config loaded from .env
├── templates/
│   └── index.html  # Dashboard UI
├── static/
│   ├── style.css   # Light theme styles
│   └── main.js     # Frontend polling and alert rendering
├── alerts/         # Saved alert frame images (gitignored)
├── .env            # Credentials (gitignored, never commit)
└── requirements.txt
```
