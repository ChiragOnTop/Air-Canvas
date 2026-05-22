# Air Canvas

Draw in the air over a live webcam feed using OpenCV and MediaPipe hand tracking.

## Features

- Tracks one hand in real time.
- Mirrors the camera feed for natural movement.
- Draws a blue stroke when only the index finger is raised.
- Pauses drawing when the index and middle fingers are raised.
- Press `c` to clear the canvas.
- Press `q` to quit safely.
- Includes a phone-friendly installable web app.

## Phone App

The mobile app is the static PWA in `index.html`.

1. Push this repo to GitHub.
2. Open GitHub repo `Settings` > `Pages`.
3. Set source to `Deploy from a branch`, branch `main`, folder `/root`.
4. Open the Pages URL on your phone.
5. Tap `Start`, allow camera access, then add it to your home screen.

On iPhone, use Safari and choose `Share` > `Add to Home Screen`.
On Android, use Chrome and choose `Install app` or `Add to Home screen`.

## Python Desktop Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Python Desktop Run

```bash
python3 air_canvas.py
```

On newer MediaPipe builds, the script downloads `hand_landmarker.task` on first run.
