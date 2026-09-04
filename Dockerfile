# OpenEye — AI Camera Monitoring System
# ========================================
# NOTE: Live camera mode requires a physical USB webcam.
# In Docker, the webcam is NOT available unless explicitly passed through:
#   docker compose up --device /dev/video0
# or add `devices: ["/dev/video0:/dev/video0"]` to docker-compose.yml.
#
# For judges / testers without a webcam:
#   Demo mode with the included sample video works fully — no hardware needed.
#   Just click "Use Sample Scene" in the dashboard and start monitoring.

FROM python:3.11-slim

# System dependencies for OpenCV (headless) and video decoding
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    libgstreamer1.0-0 \
    libgstreamer-plugins-base1.0-0 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first (layer cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create runtime directories (alerts, logs, uploads are mounted as volumes)
RUN mkdir -p alerts logs uploads

EXPOSE 5001

ENV PYTHONUNBUFFERED=1

CMD ["python", "app.py"]
