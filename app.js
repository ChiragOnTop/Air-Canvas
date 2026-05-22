"use strict";

const video = document.querySelector("#camera");
const canvas = document.querySelector("#stage");
const ctx = canvas.getContext("2d", { alpha: false });
const startButton = document.querySelector("#startButton");
const clearButton = document.querySelector("#clearButton");
const modeText = document.querySelector("#modeText");

const drawingCanvas = document.createElement("canvas");
const drawingCtx = drawingCanvas.getContext("2d");

let hands = null;
let cameraStream = null;
let animationId = 0;
let previousPoint = null;
let isRunning = false;
let isProcessingFrame = false;
let lastVideoTime = -1;
let mode = "Ready";

function setMode(nextMode) {
  if (mode !== nextMode) {
    mode = nextMode;
    modeText.textContent = nextMode;
  }
}

function resizeCanvases() {
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  const width = Math.max(1, Math.floor(window.innerWidth * dpr));
  const height = Math.max(1, Math.floor(window.innerHeight * dpr));

  if (canvas.width === width && canvas.height === height) {
    return;
  }

  const oldDrawing = document.createElement("canvas");
  oldDrawing.width = drawingCanvas.width || width;
  oldDrawing.height = drawingCanvas.height || height;
  oldDrawing.getContext("2d").drawImage(drawingCanvas, 0, 0);

  canvas.width = width;
  canvas.height = height;
  drawingCanvas.width = width;
  drawingCanvas.height = height;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawingCtx.setTransform(1, 0, 0, 1, 0, 0);
  drawingCtx.lineCap = "round";
  drawingCtx.lineJoin = "round";
  drawingCtx.strokeStyle = "#1976ff";
  drawingCtx.lineWidth = Math.max(7, Math.round(width * 0.008));
  drawingCtx.drawImage(oldDrawing, 0, 0, width, height);
}

function clearDrawing() {
  drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
  previousPoint = null;
}

function landmarkToCanvasPoint(landmark) {
  // The video is drawn mirrored, so flip normalized x before mapping to pixels.
  return {
    x: (1 - landmark.x) * canvas.width,
    y: landmark.y * canvas.height,
  };
}

function fingerIsUp(landmarks, tipId, pipId) {
  // MediaPipe y coordinates grow downward, so a smaller tip y means finger up.
  return landmarks[tipId].y < landmarks[pipId].y;
}

function getFingerState(landmarks) {
  return {
    index: fingerIsUp(landmarks, 8, 6),
    middle: fingerIsUp(landmarks, 12, 10),
    ring: fingerIsUp(landmarks, 16, 14),
    pinky: fingerIsUp(landmarks, 20, 18),
  };
}

function updateDrawingState(landmarks) {
  const fingers = getFingerState(landmarks);
  const indexOnly = fingers.index && !fingers.middle && !fingers.ring && !fingers.pinky;
  const selectionHover = fingers.index && fingers.middle && !fingers.ring && !fingers.pinky;
  const indexTip = landmarkToCanvasPoint(landmarks[8]);

  if (indexOnly) {
    setMode("Drawing");
    if (!previousPoint) {
      previousPoint = indexTip;
    }
    drawingCtx.beginPath();
    drawingCtx.moveTo(previousPoint.x, previousPoint.y);
    drawingCtx.lineTo(indexTip.x, indexTip.y);
    drawingCtx.stroke();
    previousPoint = indexTip;
    return;
  }

  if (selectionHover) {
    setMode("Hover");
  } else {
    setMode("Idle");
  }

  // Reset the brush anchor whenever drawing pauses so separate strokes do not connect.
  previousPoint = null;
}

function drawFrame() {
  resizeCanvases();

  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.restore();
  ctx.drawImage(drawingCanvas, 0, 0);
}

function onResults(results) {
  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    updateDrawingState(results.multiHandLandmarks[0]);
  } else {
    setMode("No hand");
    previousPoint = null;
  }
  isProcessingFrame = false;
}

async function renderLoop() {
  if (!isRunning) {
    return;
  }

  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    drawFrame();
    if (!isProcessingFrame && video.currentTime !== lastVideoTime) {
      isProcessingFrame = true;
      lastVideoTime = video.currentTime;
      try {
        await hands.send({ image: video });
      } catch {
        isProcessingFrame = false;
        setMode("Camera error");
      }
    }
  }

  animationId = requestAnimationFrame(renderLoop);
}

async function setupHands() {
  if (hands) {
    return hands;
  }

  if (!window.Hands) {
    throw new Error("MediaPipe failed to load.");
  }

  hands = new window.Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.7,
  });
  hands.onResults(onResults);
  return hands;
}

async function startCamera() {
  await setupHands();
  cameraStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });

  video.srcObject = cameraStream;
  await video.play();
  isRunning = true;
  startButton.textContent = "Stop";
  startButton.classList.add("is-running");
  setMode("No hand");
  renderLoop();
}

function stopCamera() {
  isRunning = false;
  cancelAnimationFrame(animationId);
  previousPoint = null;
  isProcessingFrame = false;
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  video.srcObject = null;
  startButton.textContent = "Start";
  startButton.classList.remove("is-running");
  setMode("Stopped");
}

startButton.addEventListener("click", async () => {
  if (isRunning) {
    stopCamera();
    return;
  }

  startButton.disabled = true;
  setMode("Starting");
  try {
    await startCamera();
  } catch (error) {
    setMode(error.name === "NotAllowedError" ? "Camera blocked" : "Setup failed");
  } finally {
    startButton.disabled = false;
  }
});

clearButton.addEventListener("click", clearDrawing);
window.addEventListener("resize", resizeCanvases);
window.addEventListener("orientationchange", () => {
  previousPoint = null;
  setTimeout(resizeCanvases, 250);
});

resizeCanvases();
