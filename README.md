# Air Canvas

Draw in the air over a live webcam feed using OpenCV and MediaPipe hand tracking.

## Features

- Tracks one hand in real time.
- Mirrors the camera feed for natural movement.
- Draws a blue stroke when only the index finger is raised.
- Pauses drawing when the index and middle fingers are raised.
- Press `c` to clear the canvas.
- Press `q` to quit safely.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
python3 air_canvas.py
```

On newer MediaPipe builds, the script downloads `hand_landmarker.task` on first run.
