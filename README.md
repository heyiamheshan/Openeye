# Openeye — AI Camera Monitoring System

Openeye turns any camera into an intelligent monitoring system using **natural language rules** — no model training, no labelled datasets, no configuration files. Point a webcam (or load a video), describe what you want to watch for in plain English, and Openeye uses a vision-language model (Qwen-VL) to analyse frames in real time, trigger alerts with saved evidence, send deduplicated Telegram notifications, and even **rewrite its own rules** when you tell it an alert was a false alarm.

## Features

- **Zero-shot detection** — describe rules in plain English ("Alert if a person enters the yellow zone without a hard hat")
- **Zone drawing** — draw rectangles or polygons directly on the camera feed
- **PPE checklist** — monitor specific safety equipment (helmet, vest, goggles, etc.)
- **Proximity rules** — detect when a subject is too close to a hazard
- **Scene Intelligence** — VLM analyses the camera view and proposes zones + rules automatically
- **Conversational rule refinement** — click "False alarm?" on any alert, explain why, and the rule rewrites itself
- **Telegram escalation** — deduplicated notifications with evidence frames, severity routing, per-zone contacts
- **Shift digest** — statistics and AI-generated summaries of monitoring sessions
- **Demo mode** — built-in animated warehouse scene or upload your own video

## Quick Start — Docker (recommended)

```bash
git clone https://github.com/YOUR_USERNAME/openeye
cd openeye
cp .env.example .env
# Edit .env and add your Alibaba Cloud DashScope API key
docker compose up -d
```

Open [http://localhost:5001](http://localhost:5001).

> **No webcam?** No problem. Click **"Use Sample Scene"** in the dashboard to run Demo mode with the included sample video — no hardware required.

### Live camera in Docker

To use a USB webcam, pass the device through:

```bash
docker compose up --build --device /dev/video0
```

Or uncomment the `devices` block in `docker-compose.yml`.

## Quick Start — Local

Requires **Python 3.11** and `pip`.

```bash
git clone https://github.com/YOUR_USERNAME/openeye
cd openeye
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your DashScope credentials
python app.py
```

Open [http://localhost:5001](http://localhost:5001).

## Environment Variables

See [`.env.example`](.env.example) for all options. Key variables:

| Variable | Description | Default |
|---|---|---|
| `DASHSCOPE_API_KEY` | Alibaba Cloud Model Studio API key | *(required)* |
| `API_BASE_URL` | DashScope compatible-mode endpoint | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `VL_MODEL` | Vision-language model for frame analysis | `qwen3-vl-235b-a22b-instruct` |
| `TEXT_MODEL` | Text model for refinement & digest | `qwen-plus` |
| `CAMERA_INDEX` | USB webcam index (0 = first) | `0` |
| `POLL_INTERVAL` | Seconds between frame analyses | `3` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather | *(empty = disabled)* |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | *(empty)* |
| `ESCALATION_COOLDOWN_SECONDS` | Dedup cooldown for Telegram sends | `60` |

## Usage

1. **Add a rule** — type a plain-English description or pick from the library (People, Objects, Safety, Vehicles)
2. **Draw zones** (optional) — click on the camera feed to draw rectangles or polygons, name them
3. **Start Monitoring** — the detector begins polling frames and evaluating rules
4. **View alerts** — triggered alerts appear with thumbnails, explanations, confidence scores, and delivery status
5. **Refine rules** — hover over an alert, click "False alarm?", explain why, and apply the revised rule
6. **Telegram alerts** — add your chat ID in the Telegram Alerts card to receive notifications

## Project Layout

```
openeye/
├── app.py               # Flask routes, MJPEG feed, API endpoints
├── detector.py          # Detection loop: frame capture, VLM evaluation, alert creation
├── demo_runner.py       # Demo mode analysis loop
├── config.py            # Environment configuration loader
├── scene_analyst.py     # VLM scene analysis for auto-proposing rules
├── escalation.py        # Telegram dedup + severity routing
├── notifiers.py         # Telegram Bot API sender
├── contacts_store.py    # File-backed contact management
├── incident_log.py      # Severity classification + JSONL incident log
├── rules_store.py       # File-backed rule CRUD
├── zones_store.py       # File-backed zone CRUD
├── runtime_state.py     # Shared runtime state (video path, demo mode)
├── templates/
│   └── index.html       # Dashboard UI
├── static/
│   ├── style.css        # Design system (stone/crimson theme)
│   └── main.js          # Frontend logic (polling, zones, rules, alerts)
├── demo/
│   └── sample.mp4       # Sample CCTV footage for demo mode
├── Dockerfile           # Container build
├── docker-compose.yml   # One-command deployment
└── .env.example         # All environment variables with comments
```

## License

MIT
