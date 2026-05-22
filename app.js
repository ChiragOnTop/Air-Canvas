"use strict";

const video = document.querySelector("#camera");
const canvas = document.querySelector("#stage");
const ctx = canvas.getContext("2d", { alpha: false });
const startButton = document.querySelector("#startButton");
const clearButton = document.querySelector("#clearButton");
const undoButton = document.querySelector("#undoButton");
const redoButton = document.querySelector("#redoButton");
const saveButton = document.querySelector("#saveButton");
const cameraButton = document.querySelector("#cameraButton");
const modeText = document.querySelector("#modeText");
const strokeCounter = document.querySelector("#strokeCounter");
const fpsCounter = document.querySelector("#fpsCounter");
const brushSize = document.querySelector("#brushSize");
const brushSizeValue = document.querySelector("#brushSizeValue");
const toolButtons = [...document.querySelectorAll("[data-tool]")];
const swatchButtons = [...document.querySelectorAll("[data-color]")];

const drawingCanvas = document.createElement("canvas");
const drawingCtx = drawingCanvas.getContext("2d", { willReadFrequently: true });
const MAX_HISTORY = 8;

const state = {
  color: "#1976ff",
  size: Number(brushSize.value),
  tool: "brush",
  facingMode: "user",
  strokes: 0,
};

let hands = null;
let cameraStream = null;
let animationId = 0;
let previousPoint = null;
let strokeActive = false;
let isRunning = false;
let isProcessingFrame = false;
let lastVideoTime = -1;
let lastLandmarks = null;
let mode = "Ready";
let fpsFrames = 0;
let fpsStartedAt = performance.now();
let undoStack = [];
let redoStack = [];

function setMode(nextMode) {
  if (mode !== nextMode) {
    mode = nextMode;
    modeText.textContent = nextMode;
  }
}

function updateCounters() {
  strokeCounter.textContent = String(state.strokes);
  undoButton.disabled = undoStack.length === 0;
  redoButton.disabled = redoStack.length === 0;
}

function configureDrawingContext() {
  drawingCtx.lineCap = "round";
  drawingCtx.lineJoin = "round";
  drawingCtx.strokeStyle = state.color;
  drawingCtx.lineWidth = state.size;
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
  configureDrawingContext();
  drawingCtx.drawImage(oldDrawing, 0, 0, width, height);
  undoStack = [];
  redoStack = [];
  updateCounters();
}

function captureDrawingState() {
  if (!drawingCanvas.width || !drawingCanvas.height) {
    return null;
  }
  return {
    imageData: drawingCtx.getImageData(0, 0, drawingCanvas.width, drawingCanvas.height),
    strokes: state.strokes,
  };
}

function restoreDrawingState(snapshot) {
  drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
  if (snapshot) {
    drawingCtx.putImageData(snapshot.imageData, 0, 0);
    state.strokes = snapshot.strokes;
  }
  configureDrawingContext();
}

function pushUndoState() {
  const snapshot = captureDrawingState();
  if (!snapshot) {
    return;
  }
  undoStack.push(snapshot);
  if (undoStack.length > MAX_HISTORY) {
    undoStack.shift();
  }
  redoStack = [];
  updateCounters();
}

function clearDrawing() {
  pushUndoState();
  drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
  previousPoint = null;
  strokeActive = false;
  state.strokes = 0;
  updateCounters();
}

function undo() {
  const snapshot = undoStack.pop();
  if (!snapshot) {
    return;
  }
  const current = captureDrawingState();
  if (current) {
    redoStack.push(current);
  }
  restoreDrawingState(snapshot);
  previousPoint = null;
  strokeActive = false;
  updateCounters();
}

function redo() {
  const snapshot = redoStack.pop();
  if (!snapshot) {
    return;
  }
  const current = captureDrawingState();
  if (current) {
    undoStack.push(current);
  }
  restoreDrawingState(snapshot);
  previousPoint = null;
  strokeActive = false;
  updateCounters();
}

function setTool(tool) {
  state.tool = tool;
  toolButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tool === tool);
  });
  previousPoint = null;
  strokeActive = false;
  setMode(tool === "eraser" ? "Eraser" : "Brush");
}

function setColor(color) {
  state.color = color;
  state.tool = "brush";
  configureDrawingContext();
  swatchButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.color === color);
  });
  setTool("brush");
}

function landmarkToCanvasPoint(landmark) {
  // The camera is mirrored on canvas, so flip normalized x before mapping to pixels.
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

function beginStroke(point) {
  pushUndoState();
  previousPoint = point;
  strokeActive = true;
  state.strokes += 1;
  updateCounters();
}

function drawStrokeSegment(point) {
  if (!strokeActive) {
    beginStroke(point);
  }

  drawingCtx.save();
  drawingCtx.globalCompositeOperation = state.tool === "eraser" ? "destination-out" : "source-over";
  drawingCtx.strokeStyle = state.color;
  drawingCtx.lineWidth = state.tool === "eraser" ? state.size * 1.6 : state.size;
  drawingCtx.beginPath();
  drawingCtx.moveTo(previousPoint.x, previousPoint.y);
  drawingCtx.lineTo(point.x, point.y);
  drawingCtx.stroke();
  drawingCtx.restore();
  configureDrawingContext();
  previousPoint = point;
}

function endStroke(nextMode) {
  previousPoint = null;
  strokeActive = false;
  if (nextMode) {
    setMode(nextMode);
  }
}

function updateDrawingState(landmarks) {
  const fingers = getFingerState(landmarks);
  const indexOnly = fingers.index && !fingers.middle && !fingers.ring && !fingers.pinky;
  const selectionHover = fingers.index && fingers.middle && !fingers.ring && !fingers.pinky;
  const indexTip = landmarkToCanvasPoint(landmarks[8]);

  if (indexOnly) {
    setMode(state.tool === "eraser" ? "Erasing" : "Drawing");
    drawStrokeSegment(indexTip);
    return;
  }

  endStroke(selectionHover ? "Hover" : "Idle");
}

function drawCursor() {
  if (!lastLandmarks) {
    return;
  }

  const point = landmarkToCanvasPoint(lastLandmarks[8]);
  const radius = state.tool === "eraser" ? state.size * 0.8 : state.size * 0.55;
  ctx.save();
  ctx.strokeStyle = state.tool === "eraser" ? "rgba(255,255,255,0.88)" : state.color;
  ctx.lineWidth = Math.max(2, canvas.width * 0.0025);
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawFrame() {
  resizeCanvases();

  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.restore();
  ctx.drawImage(drawingCanvas, 0, 0);
  drawCursor();
}

function updateFps() {
  fpsFrames += 1;
  const now = performance.now();
  const elapsed = now - fpsStartedAt;
  if (elapsed >= 700) {
    fpsCounter.textContent = `${Math.round((fpsFrames * 1000) / elapsed)} fps`;
    fpsFrames = 0;
    fpsStartedAt = now;
  }
}

function onResults(results) {
  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    lastLandmarks = results.multiHandLandmarks[0];
    updateDrawingState(lastLandmarks);
  } else {
    lastLandmarks = null;
    endStroke("No hand");
  }
  isProcessingFrame = false;
}

async function renderLoop() {
  if (!isRunning) {
    return;
  }

  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    drawFrame();
    updateFps();
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
    minDetectionConfidence: 0.72,
    minTrackingConfidence: 0.72,
  });
  hands.onResults(onResults);
  return hands;
}

async function startCamera() {
  await setupHands();
  cameraStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: state.facingMode },
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
  endStroke();
  isProcessingFrame = false;
  lastLandmarks = null;
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  video.srcObject = null;
  startButton.textContent = "Start";
  startButton.classList.remove("is-running");
  setMode("Stopped");
}

async function switchCamera() {
  state.facingMode = state.facingMode === "user" ? "environment" : "user";
  if (!isRunning) {
    setMode(state.facingMode === "user" ? "Front camera" : "Rear camera");
    return;
  }
  stopCamera();
  setMode("Switching");
  await startCamera();
}

async function saveImage() {
  resizeCanvases();
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = canvas.width;
  exportCanvas.height = canvas.height;
  const exportCtx = exportCanvas.getContext("2d", { alpha: false });

  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    exportCtx.save();
    exportCtx.translate(exportCanvas.width, 0);
    exportCtx.scale(-1, 1);
    exportCtx.drawImage(video, 0, 0, exportCanvas.width, exportCanvas.height);
    exportCtx.restore();
  } else {
    exportCtx.fillStyle = "#151616";
    exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
  }
  exportCtx.drawImage(drawingCanvas, 0, 0);

  exportCanvas.toBlob(async (blob) => {
    if (!blob) {
      setMode("Save failed");
      return;
    }
    const file = new File([blob], `air-canvas-${Date.now()}.png`, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Air Canvas" }).catch(() => {});
      return;
    }

    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(link.href);
  }, "image/png");
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

toolButtons.forEach((button) => {
  button.addEventListener("click", () => setTool(button.dataset.tool));
});

swatchButtons.forEach((button) => {
  button.addEventListener("click", () => setColor(button.dataset.color));
});

brushSize.addEventListener("input", () => {
  state.size = Number(brushSize.value);
  brushSizeValue.textContent = String(state.size);
  configureDrawingContext();
});

clearButton.addEventListener("click", clearDrawing);
undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);
saveButton.addEventListener("click", saveImage);
cameraButton.addEventListener("click", () => {
  switchCamera().catch(() => setMode("Camera error"));
});

window.addEventListener("resize", resizeCanvases);
window.addEventListener("orientationchange", () => {
  endStroke();
  setTimeout(resizeCanvases, 250);
});

window.addEventListener("load", () => {
  if (window.lucide) {
    window.lucide.createIcons();
  }
});

resizeCanvases();
configureDrawingContext();
updateCounters();
