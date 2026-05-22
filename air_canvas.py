#!/usr/bin/env python3
"""Air Canvas: draw over a mirrored webcam feed with MediaPipe hand tracking."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple
from urllib.error import URLError
from urllib.request import Request, urlopen

# MediaPipe imports matplotlib in some builds; keep its cache in a writable place.
os.environ.setdefault("MPLCONFIGDIR", "/tmp/matplotlib")

import cv2
import mediapipe as mp
import numpy as np


Point = Tuple[int, int]
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task"
)
HAND_CONNECTIONS = (
    (0, 1),
    (1, 5),
    (9, 13),
    (13, 17),
    (5, 9),
    (0, 17),
    (1, 2),
    (2, 3),
    (3, 4),
    (5, 6),
    (6, 7),
    (7, 8),
    (9, 10),
    (10, 11),
    (11, 12),
    (13, 14),
    (14, 15),
    (15, 16),
    (17, 18),
    (18, 19),
    (19, 20),
)


@dataclass(frozen=True)
class AppConfig:
    camera_index: int
    frame_width: int
    frame_height: int
    stroke_width: int
    min_detection_confidence: float
    min_tracking_confidence: float
    model_path: Path
    auto_download_model: bool


def parse_args() -> AppConfig:
    parser = argparse.ArgumentParser(
        description="Draw in the air using one tracked hand, OpenCV, and MediaPipe."
    )
    parser.add_argument("--camera-index", type=int, default=0, help="Webcam index.")
    parser.add_argument("--frame-width", type=int, default=1280, help="Requested capture width.")
    parser.add_argument("--frame-height", type=int, default=720, help="Requested capture height.")
    parser.add_argument("--stroke-width", type=int, default=8, help="Drawing stroke thickness.")
    parser.add_argument(
        "--model-path",
        type=Path,
        default=Path(__file__).resolve().with_name("hand_landmarker.task"),
        help="MediaPipe Tasks hand landmarker model path, used only on newer MediaPipe builds.",
    )
    parser.add_argument(
        "--no-auto-download-model",
        action="store_true",
        help="Do not download the Tasks hand model automatically if it is missing.",
    )
    parser.add_argument(
        "--min-detection-confidence",
        type=float,
        default=0.7,
        help="MediaPipe hand detection confidence threshold.",
    )
    parser.add_argument(
        "--min-tracking-confidence",
        type=float,
        default=0.7,
        help="MediaPipe hand tracking confidence threshold.",
    )
    args = parser.parse_args()

    if args.stroke_width < 1:
        parser.error("--stroke-width must be at least 1")
    for flag_name in ("min_detection_confidence", "min_tracking_confidence"):
        value = getattr(args, flag_name)
        if not 0.0 <= value <= 1.0:
            parser.error(f"--{flag_name.replace('_', '-')} must be between 0 and 1")

    return AppConfig(
        camera_index=args.camera_index,
        frame_width=args.frame_width,
        frame_height=args.frame_height,
        stroke_width=args.stroke_width,
        min_detection_confidence=args.min_detection_confidence,
        min_tracking_confidence=args.min_tracking_confidence,
        model_path=args.model_path.expanduser(),
        auto_download_model=not args.no_auto_download_model,
    )


def open_camera(config: AppConfig) -> cv2.VideoCapture:
    cap = cv2.VideoCapture(config.camera_index)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open webcam at index {config.camera_index}.")

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.frame_width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.frame_height)
    return cap


def normalized_landmark_to_pixel(landmark, width: int, height: int) -> Point:
    """Map MediaPipe's normalized landmark coordinates into image pixels."""
    x = min(max(int(landmark.x * width), 0), width - 1)
    y = min(max(int(landmark.y * height), 0), height - 1)
    return x, y


def download_model(model_path: Path) -> None:
    model_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = model_path.with_suffix(model_path.suffix + ".download")
    request = Request(MODEL_URL, headers={"User-Agent": "air-canvas/1.0"})

    try:
        with urlopen(request, timeout=30) as response, tmp_path.open("wb") as output:
            shutil.copyfileobj(response, output)
        tmp_path.replace(model_path)
    except (OSError, URLError) as exc:
        tmp_path.unlink(missing_ok=True)
        raise RuntimeError(
            "MediaPipe Tasks needs a hand model file, but automatic download failed. "
            f"Download it manually from {MODEL_URL} and save it as {model_path}."
        ) from exc


def finger_is_up(landmarks, tip_id: int, pip_id: int) -> bool:
    # In image coordinates, a smaller y value is physically higher in the frame.
    return landmarks[tip_id].y < landmarks[pip_id].y


def get_finger_state(landmarks) -> tuple[bool, bool, bool, bool]:
    """Return extension state for index, middle, ring, and pinky fingers."""
    index_up = finger_is_up(landmarks, 8, 6)
    middle_up = finger_is_up(landmarks, 12, 10)
    ring_up = finger_is_up(landmarks, 16, 14)
    pinky_up = finger_is_up(landmarks, 20, 18)
    return index_up, middle_up, ring_up, pinky_up


def draw_hand_landmarks(frame: np.ndarray, landmarks) -> None:
    height, width = frame.shape[:2]
    points = [normalized_landmark_to_pixel(landmark, width, height) for landmark in landmarks]

    for start, end in HAND_CONNECTIONS:
        cv2.line(frame, points[start], points[end], (70, 220, 70), 2, cv2.LINE_AA)

    for point in points:
        cv2.circle(frame, point, 4, (40, 40, 255), -1, cv2.LINE_AA)


class SolutionsHandTracker:
    """Adapter for older MediaPipe builds that still expose mp.solutions.hands."""

    def __init__(self, config: AppConfig) -> None:
        self._config = config
        self._hands = None

    def __enter__(self):
        self._hands = mp.solutions.hands.Hands(
            static_image_mode=False,
            max_num_hands=1,
            min_detection_confidence=self._config.min_detection_confidence,
            min_tracking_confidence=self._config.min_tracking_confidence,
        )
        return self

    def detect(self, rgb_frame: np.ndarray, timestamp_ms: int):
        del timestamp_ms
        results = self._hands.process(rgb_frame)
        if not results.multi_hand_landmarks:
            return []
        return [hand.landmark for hand in results.multi_hand_landmarks]

    def __exit__(self, exc_type, exc, traceback) -> None:
        del exc_type, exc, traceback
        if self._hands is not None:
            self._hands.close()


class TasksHandTracker:
    """Adapter for newer MediaPipe builds where hand tracking lives in Tasks."""

    def __init__(self, config: AppConfig) -> None:
        self._config = config
        self._landmarker = None

    def __enter__(self):
        if not self._config.model_path.exists():
            if not self._config.auto_download_model:
                raise RuntimeError(
                    f"Missing hand model: {self._config.model_path}. "
                    f"Download it from {MODEL_URL}, or rerun without --no-auto-download-model."
                )
            print(f"Downloading MediaPipe hand model to {self._config.model_path}...")
            download_model(self._config.model_path)

        from mediapipe.tasks.python.core import base_options as base_options_module
        from mediapipe.tasks.python.vision import hand_landmarker
        from mediapipe.tasks.python.vision.core import vision_task_running_mode

        options = hand_landmarker.HandLandmarkerOptions(
            base_options=base_options_module.BaseOptions(
                model_asset_path=str(self._config.model_path)
            ),
            running_mode=vision_task_running_mode.VisionTaskRunningMode.VIDEO,
            num_hands=1,
            min_hand_detection_confidence=self._config.min_detection_confidence,
            min_hand_presence_confidence=self._config.min_detection_confidence,
            min_tracking_confidence=self._config.min_tracking_confidence,
        )
        self._landmarker = hand_landmarker.HandLandmarker.create_from_options(options)
        return self

    def detect(self, rgb_frame: np.ndarray, timestamp_ms: int):
        mp_image = mp.Image(
            image_format=mp.ImageFormat.SRGB,
            data=np.ascontiguousarray(rgb_frame),
        )
        result = self._landmarker.detect_for_video(mp_image, timestamp_ms)
        return result.hand_landmarks

    def __exit__(self, exc_type, exc, traceback) -> None:
        del exc_type, exc, traceback
        if self._landmarker is not None:
            self._landmarker.close()


def create_hand_tracker(config: AppConfig):
    if hasattr(mp, "solutions") and hasattr(mp.solutions, "hands"):
        return SolutionsHandTracker(config)
    return TasksHandTracker(config)


def overlay_canvas(frame: np.ndarray, canvas: np.ndarray) -> np.ndarray:
    """Place opaque strokes from the canvas over the live frame without alpha artifacts."""
    canvas_gray = cv2.cvtColor(canvas, cv2.COLOR_BGR2GRAY)
    _, stroke_mask = cv2.threshold(canvas_gray, 1, 255, cv2.THRESH_BINARY)
    inverse_mask = cv2.bitwise_not(stroke_mask)

    live_background = cv2.bitwise_and(frame, frame, mask=inverse_mask)
    visible_strokes = cv2.bitwise_and(canvas, canvas, mask=stroke_mask)
    return cv2.bitwise_or(live_background, visible_strokes)


def draw_status_bar(frame: np.ndarray, mode: str) -> None:
    cv2.rectangle(frame, (0, 0), (frame.shape[1], 42), (20, 20, 20), -1)
    cv2.putText(
        frame,
        f"Mode: {mode} | c: clear | q: quit",
        (16, 28),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.75,
        (255, 255, 255),
        2,
        cv2.LINE_AA,
    )


def run_air_canvas(config: AppConfig) -> None:
    cap = open_camera(config)

    canvas: Optional[np.ndarray] = None
    previous_point: Optional[Point] = None

    try:
        with create_hand_tracker(config) as hand_tracker:
            while True:
                ok, frame = cap.read()
                if not ok:
                    raise RuntimeError("Webcam frame read failed.")

                # Mirror first so visual feedback and landmark coordinates match the user's motion.
                frame = cv2.flip(frame, 1)
                height, width = frame.shape[:2]

                if canvas is None or canvas.shape != frame.shape:
                    canvas = np.zeros_like(frame)

                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                rgb_frame.flags.writeable = False
                landmarks_by_hand = hand_tracker.detect(rgb_frame, int(time.monotonic() * 1000))
                rgb_frame.flags.writeable = True

                mode = "No hand"

                if landmarks_by_hand:
                    landmarks = landmarks_by_hand[0]
                    index_up, middle_up, ring_up, pinky_up = get_finger_state(landmarks)
                    index_tip = normalized_landmark_to_pixel(landmarks[8], width, height)

                    index_only = index_up and not middle_up and not ring_up and not pinky_up
                    selection_hover = index_up and middle_up and not ring_up and not pinky_up

                    if index_only:
                        mode = "Drawing"
                        # Join consecutive drawing points; initialize on first contact to avoid jumps.
                        if previous_point is None:
                            previous_point = index_tip
                        cv2.line(
                            canvas,
                            previous_point,
                            index_tip,
                            (255, 0, 0),
                            config.stroke_width,
                            cv2.LINE_AA,
                        )
                        previous_point = index_tip
                    elif selection_hover:
                        mode = "Selection/Hover"
                        # Reset the brush anchor so the next stroke starts cleanly elsewhere.
                        previous_point = None
                    else:
                        mode = "Idle"
                        previous_point = None

                    draw_hand_landmarks(frame, landmarks)
                else:
                    previous_point = None

                output = overlay_canvas(frame, canvas)
                draw_status_bar(output, mode)
                cv2.imshow("Air Canvas", output)

                key = cv2.waitKey(1) & 0xFF
                if key == ord("c"):
                    canvas[:] = 0
                    previous_point = None
                elif key == ord("q"):
                    break
    finally:
        cap.release()
        cv2.destroyAllWindows()


def main() -> int:
    try:
        run_air_canvas(parse_args())
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"Air Canvas error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
