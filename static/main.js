// ═══════════════════════════════════════════════════════════════════════════
// OpenEye — main.js
// Feed: live MJPEG or canvas-rendered demo scenes streamed into a video player.
// Zone drawing: Draw zone freezes the feed → draw a shape (rect/poly/circle)
// → drag to reposition → name it → saved to the backend.
// Rules: managed as a frontend list, combined into one rule string on Start.
// ═══════════════════════════════════════════════════════════════════════════

// ── DOM refs ──────────────────────────────────────────────────────────────────
const feedImg     = document.getElementById('cameraFeed');
const demoVideo   = document.getElementById('demoVideo');
const sceneCanvas = document.getElementById('demoSceneCanvas');
const sceneCtx    = sceneCanvas.getContext('2d');
const canvas      = document.getElementById('zoneCanvas');
const ctx         = canvas.getContext('2d');
const drawBtn     = document.getElementById('drawZoneBtn');
const hintEl      = document.getElementById('drawHint');
const promptEl    = document.getElementById('zoneNamePrompt');
const nameInput   = document.getElementById('zoneNameInput');
const frameEl     = document.getElementById('cameraFrame');
const frozenFrameEl = document.getElementById('frozenFrame');

// ── constants ─────────────────────────────────────────────────────────────────
const ROSE_FILL      = 'rgba(255,241,242,0.30)';   // rose-50 @ 30% opacity
const ROSE_FILL_MOVE = 'rgba(255,241,242,0.45)';
const ROSE_STROKE    = '#FDA4AF';                  // rose-300
const ROSE_LABEL     = '#E11D48';                  // rose-600
const HANDLE_R        = 6;
const CIRCLE_SEGS     = 48;
const DEMO_W          = 1280;
const DEMO_H          = 720;

// ── state ─────────────────────────────────────────────────────────────────────
let feedMode = 'live';               // 'live' | 'demo'
let phase    = 'idle';               // 'idle' | 'draw' | 'move' | 'name'
let drawMode = 'rect';               // 'rect' | 'poly' | 'circle'
let pendingPoly = null;              // normalised [[x,y]…]
let savedZones  = {};                // name → [[x,y]…] normalised
let rules       = [];                // synced from backend: {id, text, zone, enabled, zoneCleared}
let monitoringActive = false;

// draw-phase state
let rectStart    = null;
let rectCur      = null;
let polyPts      = [];
let mousePos     = null;
let circleCenter = null;
let circleEdge   = null;

// move-phase state
let moveActive = false;
let moveLast   = null;

// demo state
let demoStreamStarted = false;

// ── canvas sizing ─────────────────────────────────────────────────────────────
function syncCanvasSize() {
  const r = canvas.getBoundingClientRect();
  if (r.width === 0) return;
  canvas.width  = r.width;
  canvas.height = r.height;
  redraw();
}
new ResizeObserver(syncCanvasSize).observe(canvas);

// ── camera overlay ────────────────────────────────────────────────────────────
function showCameraOverlay() {
  if (feedMode === 'live') document.getElementById('cameraOverlay').classList.add('visible');
}
function hideCameraOverlay() {
  document.getElementById('cameraOverlay').classList.remove('visible');
}
feedImg.addEventListener('error', () => {
  // ignore the synthetic error fired while the src is blanked for freeze-frame
  if (!feedImg.dataset.liveSrc) showCameraOverlay();
});
feedImg.addEventListener('load', hideCameraOverlay);
// the error may fire before this script attaches (src is set in the HTML)
if (feedImg.complete && feedImg.naturalWidth === 0 && !feedImg.dataset.liveSrc) {
  showCameraOverlay();
}
// a failed camera keeps the stream open with zero bytes — the img never errors,
// so poll until the first real frame arrives
setTimeout(() => {
  const t = setInterval(() => {
    if (feedMode !== 'live' || feedImg.dataset.liveSrc) return;
    if (feedImg.naturalWidth > 0) { hideCameraOverlay(); clearInterval(t); return; }
    showCameraOverlay();
  }, 2000);
}, 6000);

// ── feed freeze / resume (works for live img and demo video) ─────────────────
function activeMediaEl() {
  return feedMode === 'demo' ? demoVideo : feedImg;
}

// Freezing shows a static snapshot behind the (transparent) drawing canvas —
// it must live in its own layer, not be drawn onto #zoneCanvas itself, since
// redraw() clears that canvas on every mousemove while drawing/moving a zone.
function freezeFeed() {
  const r = canvas.getBoundingClientRect();
  canvas.width  = r.width;
  canvas.height = r.height;
  const media = activeMediaEl();

  let captured = false;
  try {
    const tmp = document.createElement('canvas');
    tmp.width  = canvas.width;
    tmp.height = canvas.height;
    tmp.getContext('2d').drawImage(media, 0, 0, tmp.width, tmp.height);
    frozenFrameEl.src = tmp.toDataURL('image/jpeg', 0.9);
    captured = true;
  } catch (_) {
    captured = false;
  }

  if (!captured) {
    // couldn't capture from the live media element — fall back to the
    // backend's last-known frame instead of showing a black screen
    frozenFrameEl.src = `/current_frame?ts=${Date.now()}`;
  }
  frozenFrameEl.hidden = false;

  if (feedMode === 'demo') {
    demoVideo.pause();
  } else {
    feedImg.dataset.liveSrc = feedImg.src;
    feedImg.src = '';
  }
  frameEl.classList.add('freeze');
}

function resumeFeed() {
  frameEl.classList.remove('freeze');
  frozenFrameEl.hidden = true;
  frozenFrameEl.src = '';
  if (feedMode === 'demo') {
    demoVideo.play().catch(() => {});
  } else if (feedImg.dataset.liveSrc) {
    feedImg.src = feedImg.dataset.liveSrc;
    delete feedImg.dataset.liveSrc;
  }
  syncCanvasSize();
}

// ═════════════════════════════════════════════════════════════════════════════
// DEMO MODE — real backend analysis (/demo_run/*), rendered into #demoVideo via
// the existing sceneCanvas → captureStream pipeline (each analysed frame is
// drawn onto the canvas instead of a procedural animation).
// ═════════════════════════════════════════════════════════════════════════════

let demoActive       = false;
let demoPollInterval = null;
const demoFrameImg   = new Image();
demoFrameImg.onload  = () => sceneCtx.drawImage(demoFrameImg, 0, 0, DEMO_W, DEMO_H);

function setFeedMode(mode) {
  if (mode === feedMode) return;
  if (phase !== 'idle') cancelDraw();
  feedMode = mode;
  document.querySelectorAll('#feedModeToggle .mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  const isDemo = mode === 'demo';
  feedImg.hidden   = isDemo;
  demoVideo.hidden = !isDemo;
  document.getElementById('demoStrip').hidden = !isDemo;
  hideCameraOverlay();
  if (isDemo) {
    ensureDemoStream();
    demoVideo.play().catch(() => {});
    renderDemoSources();
    if (!demoActive) drawDemoPlaceholder();
  } else {
    demoVideo.pause();
    if (feedImg.dataset.liveSrc) {
      feedImg.src = feedImg.dataset.liveSrc;
      delete feedImg.dataset.liveSrc;
    }
    if (feedImg.complete && feedImg.naturalWidth === 0 && !feedImg.dataset.liveSrc) {
      showCameraOverlay();
    }
  }
}

document.querySelectorAll('#feedModeToggle .mode-btn').forEach(btn => {
  btn.addEventListener('click', () => setFeedMode(btn.dataset.mode));
});

function ensureDemoStream() {
  if (demoStreamStarted) return;
  try {
    demoVideo.srcObject = sceneCanvas.captureStream(30);
    demoStreamStarted = true;
  } catch (e) {
    console.warn('Demo stream unavailable:', e);
  }
}

function drawDemoPlaceholder() {
  sceneCtx.fillStyle = '#1C1917';
  sceneCtx.fillRect(0, 0, DEMO_W, DEMO_H);
  sceneCtx.fillStyle = '#A8A29E';
  sceneCtx.font = '600 24px -apple-system,system-ui,sans-serif';
  sceneCtx.textAlign = 'center';
  sceneCtx.textBaseline = 'middle';
  sceneCtx.fillText('Select a video source below to begin analysis', DEMO_W / 2, DEMO_H / 2);
}

function setDemoStatus(msg, isSummary) {
  const el = document.getElementById('demoStatusText');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('summary', !!isSummary);
}

function renderDemoSources() {
  const wrap = document.getElementById('demoSources');
  wrap.innerHTML = '';
  const hasEnabledRule = rules.filter(r => r.enabled).length > 0;

  const sampleBtn = document.createElement('button');
  sampleBtn.type = 'button';
  sampleBtn.className = 'demo-src';
  sampleBtn.textContent = 'Use sample video';
  sampleBtn.disabled = !hasEnabledRule || demoActive;
  sampleBtn.addEventListener('click', useSampleVideo);
  wrap.appendChild(sampleBtn);

  const uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.className = 'demo-src';
  uploadBtn.textContent = 'Upload video';
  uploadBtn.disabled = !hasEnabledRule || demoActive;
  uploadBtn.addEventListener('click', () => document.getElementById('demoVideoInput').click());
  wrap.appendChild(uploadBtn);

  if (demoActive) {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'demo-src active';
    cancelBtn.textContent = 'Cancel analysis';
    cancelBtn.addEventListener('click', cancelDemoRun);
    wrap.appendChild(cancelBtn);
  }

  if (!hasEnabledRule && !demoActive) {
    setDemoStatus('Add at least one enabled rule before selecting a video.');
  }
}

function useSampleVideo() {
  if (rules.filter(r => r.enabled).length === 0) return;
  setDemoStatus('Loading sample video…');
  fetch('/demo_run/load_sample', { method: 'POST' })
    .then(r => r.json())
    .then(d => {
      if (!d.ok) { setDemoStatus(d.error || 'Failed to load sample video'); return; }
      startDemoRun();
    })
    .catch(() => setDemoStatus('Failed to load sample video'));
}

document.getElementById('demoVideoInput').addEventListener('change', () => {
  const input = document.getElementById('demoVideoInput');
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('video', file);
  setDemoStatus('Uploading…');
  fetch('/upload_video', { method: 'POST', body: form })
    .then(r => r.json())
    .then(d => {
      input.value = '';
      if (!d.ok) { setDemoStatus(d.error || 'Upload failed'); return; }
      startDemoRun();
    })
    .catch(() => setDemoStatus('Upload failed'));
});

function startDemoRun() {
  fetch('/demo_run/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
    .then(r => r.json())
    .then(d => {
      if (!d.ok) { setDemoStatus(d.error || 'Failed to start analysis'); return; }
      demoActive = true;
      renderDemoSources();
      document.getElementById('demoProgress').style.width = '0%';
      setDemoStatus('Starting…');
      if (demoPollInterval) clearInterval(demoPollInterval);
      demoPollInterval = setInterval(pollDemoRun, 700);
      pollDemoRun();
    })
    .catch(() => setDemoStatus('Failed to start analysis'));
}

function pollDemoRun() {
  fetch('/demo_run/status').then(r => r.json()).then(d => {
    if (!d.active) return;
    const pct = d.total ? (d.current_index / d.total) * 100 : 0;
    document.getElementById('demoProgress').style.width = pct.toFixed(1) + '%';
    const ruleSuffix = d.current_rule_label ? ` — Rule: ${d.current_rule_label}` : '';
    setDemoStatus(`Analysing frame ${d.current_index} of ${d.total}${ruleSuffix}`);
    demoFrameImg.src = `/demo_run/frame?ts=${Date.now()}`;
    renderAlerts(d.alerts || []);

    if (d.done) {
      clearInterval(demoPollInterval);
      demoPollInterval = null;
      demoActive = false;
      renderDemoSources();
      const alertCount = (d.alerts || []).length;
      const ruleCount = new Set((d.alerts || []).map(a => a.rule)).size;
      setDemoStatus(
        `Analysed ${d.total} frame${d.total === 1 ? '' : 's'} — ` +
        `${alertCount} alert${alertCount === 1 ? '' : 's'} triggered across ` +
        `${ruleCount} rule${ruleCount === 1 ? '' : 's'}.`,
        true
      );
    }
  }).catch(() => {});
}

function cancelDemoRun() {
  fetch('/demo_run/cancel', { method: 'POST' }).then(() => {
    if (demoPollInterval) { clearInterval(demoPollInterval); demoPollInterval = null; }
    demoActive = false;
    renderDemoSources();
    setDemoStatus('Cancelled.');
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// ZONE DRAWING
// ═════════════════════════════════════════════════════════════════════════════

function toggleDrawMode() {
  if (phase !== 'idle') { cancelDraw(); } else { enterDraw(); }
}

const DRAW_HINTS = {
  rect:   'Click and drag to draw a rectangle zone',
  poly:   'Click to place vertices · Double-click or click first point to close',
  circle: 'Click the centre, drag to set radius',
};

function enterDraw() {
  phase = 'draw';
  rectStart = rectCur = null;
  polyPts   = [];
  mousePos  = null;
  pendingPoly = null;
  circleCenter = circleEdge = null;
  moveActive = false; moveLast = null;
  promptEl.classList.remove('visible');
  document.getElementById('shapePicker').hidden = false;

  drawMode = (document.querySelector('input[name="drawMode"]:checked') || {}).value || 'rect';

  freezeFeed();

  drawBtn.classList.add('btn-draw-active');
  drawBtn.textContent = 'Cancel';
  canvas.classList.add('drawing');

  setHint(DRAW_HINTS[drawMode] || '');
  redraw();
}

function enterMove() {
  phase = 'move';
  moveActive = false;
  moveLast   = null;
  canvas.classList.remove('drawing');
  canvas.classList.add('moving');
  setHint('Drag to reposition the zone, then name it below ↓');
  redraw();
}

function cancelDraw() {
  phase = 'idle';
  rectStart = rectCur = null;
  polyPts = []; mousePos = null;
  pendingPoly = null;
  circleCenter = circleEdge = null;
  moveActive = false; moveLast = null;

  drawBtn.classList.remove('btn-draw-active');
  drawBtn.textContent = 'Draw zone';
  canvas.classList.remove('drawing', 'moving', 'grabbing');
  document.getElementById('shapePicker').hidden = true;
  promptEl.classList.remove('visible');
  setHint('');

  resumeFeed();
  syncCanvasSize();
}

function setHint(msg) { hintEl.textContent = msg; }

// switching shape mid-draw restarts the current shape
document.querySelectorAll('input[name="drawMode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    if (phase !== 'draw') return;
    drawMode = radio.value;
    rectStart = rectCur = null;
    polyPts = []; mousePos = null;
    circleCenter = circleEdge = null;
    setHint(DRAW_HINTS[drawMode] || '');
    redraw();
  });
});

// ── canvas mouse handlers ─────────────────────────────────────────────────────
canvas.addEventListener('mousedown', (e) => {
  if (phase === 'idle') return;
  const p = evPt(e);

  if (phase === 'draw') {
    if (drawMode === 'rect')   { rectStart = p; rectCur = p; }
    if (drawMode === 'circle') { circleCenter = p; circleEdge = p; }
  }

  if (phase === 'move' || phase === 'name') {
    if (pointInPendingPoly(p)) {
      moveActive = true;
      moveLast   = p;
      canvas.classList.add('grabbing');
    }
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (phase === 'idle') return;
  const p = evPt(e);
  mousePos = p;

  if (phase === 'draw') {
    if (drawMode === 'rect'   && rectStart)    rectCur    = p;
    if (drawMode === 'circle' && circleCenter) circleEdge = p;
  }

  if ((phase === 'move' || phase === 'name') && moveActive && pendingPoly) {
    const dx = (p.x - moveLast.x) / canvas.width;
    const dy = (p.y - moveLast.y) / canvas.height;
    pendingPoly = pendingPoly.map(([nx, ny]) => [nx + dx, ny + dy]);
    moveLast = p;
  }

  if (phase === 'move' || phase === 'name') {
    canvas.style.cursor = pointInPendingPoly(p) ? (moveActive ? 'grabbing' : 'grab') : 'default';
  }

  redraw();
});

canvas.addEventListener('mouseup', (e) => {
  if (phase === 'idle') return;
  const p = evPt(e);

  if (phase === 'draw') {
    if (drawMode === 'rect' && rectStart) {
      rectCur = p;
      const w = Math.abs(rectCur.x - rectStart.x);
      const h = Math.abs(rectCur.y - rectStart.y);
      if (w < 8 || h < 8) { rectStart = rectCur = null; redraw(); return; }
      finishRect();
    } else if (drawMode === 'circle' && circleCenter) {
      circleEdge = p;
      const dx = circleEdge.x - circleCenter.x;
      const dy = circleEdge.y - circleCenter.y;
      if (Math.sqrt(dx*dx + dy*dy) < 8) { circleCenter = circleEdge = null; redraw(); return; }
      finishCircle();
    }
  }

  if ((phase === 'move' || phase === 'name') && moveActive) {
    moveActive = false;
    canvas.classList.remove('grabbing');
    redraw();
  }
});

canvas.addEventListener('click', (e) => {
  if (phase !== 'draw' || drawMode !== 'poly') return;
  const p = evPt(e);
  if (polyPts.length >= 3) {
    const dx = polyPts[0].x - p.x;
    const dy = polyPts[0].y - p.y;
    if (Math.sqrt(dx*dx + dy*dy) <= HANDLE_R * 2.5) { finishPoly(); return; }
  }
  polyPts.push(p);
  redraw();
});

canvas.addEventListener('dblclick', (e) => {
  if (phase !== 'draw' || drawMode !== 'poly' || polyPts.length < 3) return;
  e.preventDefault();
  polyPts.pop();
  finishPoly();
});

// ── pointer helpers ───────────────────────────────────────────────────────────
function evPt(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function pointInPendingPoly(p) {
  if (!pendingPoly || pendingPoly.length < 3) return false;
  const pts = pendingPoly.map(([nx, ny]) => ({ x: nx * canvas.width, y: ny * canvas.height }));
  if (pendingPoly.length === CIRCLE_SEGS) {
    const cx = pts.reduce((s, q) => s + q.x, 0) / pts.length;
    const cy = pts.reduce((s, q) => s + q.y, 0) / pts.length;
    const r  = pts.reduce((s, q) => s + Math.sqrt((q.x - cx) ** 2 + (q.y - cy) ** 2), 0) / pts.length;
    return Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2) <= r;
  }
  let inside = false, j = pts.length - 1;
  for (let i = 0; i < pts.length; i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < (xj - xi) * (p.y - yi) / (yj - yi + 1e-12) + xi) inside = !inside;
    j = i;
  }
  return inside;
}

// ── finish drawing → enter move phase ─────────────────────────────────────────
function finishRect() {
  const x1 = Math.min(rectStart.x, rectCur.x) / canvas.width;
  const y1 = Math.min(rectStart.y, rectCur.y) / canvas.height;
  const x2 = Math.max(rectStart.x, rectCur.x) / canvas.width;
  const y2 = Math.max(rectStart.y, rectCur.y) / canvas.height;
  pendingPoly = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
  rectStart = rectCur = null;
  enterMove();
  showNamePrompt();
}

function finishPoly() {
  pendingPoly = polyPts.map(p => [p.x / canvas.width, p.y / canvas.height]);
  polyPts = [];
  enterMove();
  showNamePrompt();
}

function finishCircle() {
  const cx = circleCenter.x, cy = circleCenter.y;
  const dx = circleEdge.x - cx, dy = circleEdge.y - cy;
  const r  = Math.sqrt(dx * dx + dy * dy);
  pendingPoly = Array.from({ length: CIRCLE_SEGS }, (_, i) => {
    const a = (i / CIRCLE_SEGS) * Math.PI * 2;
    return [(cx + Math.cos(a) * r) / canvas.width, (cy + Math.sin(a) * r) / canvas.height];
  });
  circleCenter = circleEdge = null;
  enterMove();
  showNamePrompt();
}

// ── name prompt ───────────────────────────────────────────────────────────────
function showNamePrompt() {
  phase = 'name';
  setHint('Drag to reposition · then name and save ↓');
  promptEl.classList.add('visible');
  nameInput.value = '';
  nameInput.focus();
}

function hidePendingPrompt() {
  promptEl.classList.remove('visible');
  cancelDraw();
}

function confirmZoneName() {
  const name = nameInput.value.trim();
  if (!name || !pendingPoly) return;
  fetch('/zones', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, points: pendingPoly }),
  })
    .then(r => r.json())
    .then(d => {
      if (d.ok) {
        savedZones[name] = pendingPoly;
        pendingPoly = null;
        promptEl.classList.remove('visible');
        renderZoneList();
        syncZoneSelect();
        cancelDraw();
      }
    });
}

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  confirmZoneName();
  if (e.key === 'Escape') hidePendingPrompt();
});

// ── redraw ────────────────────────────────────────────────────────────────────
function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const [name, pts] of Object.entries(savedZones)) {
    drawZoneShape(pts, ROSE_FILL, ROSE_STROKE, false);
    const px = pts.map(p => ({ x: p[0] * canvas.width, y: p[1] * canvas.height }));
    const cx = px.reduce((s, p) => s + p.x, 0) / px.length;
    const cy = px.reduce((s, p) => s + p.y, 0) / px.length;
    drawLabel(name, cx, cy);
  }

  if (phase === 'idle') return;

  if (phase === 'draw') {
    if (drawMode === 'rect' && rectStart && rectCur) {
      const x = Math.min(rectStart.x, rectCur.x);
      const y = Math.min(rectStart.y, rectCur.y);
      const w = Math.abs(rectCur.x - rectStart.x);
      const h = Math.abs(rectCur.y - rectStart.y);
      ctx.fillStyle = ROSE_FILL; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = ROSE_STROKE; ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
    }

    if (drawMode === 'poly' && polyPts.length > 0) {
      ctx.beginPath();
      ctx.moveTo(polyPts[0].x, polyPts[0].y);
      polyPts.forEach(p => ctx.lineTo(p.x, p.y));
      if (mousePos) ctx.lineTo(mousePos.x, mousePos.y);
      ctx.strokeStyle = ROSE_STROKE; ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]); ctx.stroke(); ctx.setLineDash([]);
      polyPts.forEach((p, i) => {
        ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? ROSE_STROKE : '#fff';
        ctx.strokeStyle = ROSE_STROKE; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
      });
      if (polyPts.length >= 3) {
        ctx.beginPath(); ctx.arc(polyPts[0].x, polyPts[0].y, HANDLE_R + 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(217,119,6,0.4)'; ctx.lineWidth = 2; ctx.stroke();
      }
    }

    if (drawMode === 'circle' && circleCenter) {
      const edge = circleEdge || mousePos || circleCenter;
      const dx = edge.x - circleCenter.x, dy = edge.y - circleCenter.y;
      const r = Math.sqrt(dx * dx + dy * dy);
      ctx.beginPath(); ctx.arc(circleCenter.x, circleCenter.y, Math.max(r, 1), 0, Math.PI * 2);
      ctx.fillStyle = ROSE_FILL; ctx.fill();
      ctx.strokeStyle = ROSE_STROKE; ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]); ctx.stroke(); ctx.setLineDash([]);
      if (r > 8) {
        ctx.beginPath(); ctx.moveTo(circleCenter.x, circleCenter.y); ctx.lineTo(edge.x, edge.y);
        ctx.strokeStyle = 'rgba(217,119,6,0.5)'; ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.beginPath(); ctx.arc(circleCenter.x, circleCenter.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = ROSE_STROKE; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
    }
  }

  if ((phase === 'move' || phase === 'name') && pendingPoly) {
    drawZoneShape(pendingPoly, moveActive ? ROSE_FILL_MOVE : ROSE_FILL, ROSE_STROKE, true);
    const px = pendingPoly.map(p => ({ x: p[0] * canvas.width, y: p[1] * canvas.height }));
    const cx = px.reduce((s, p) => s + p.x, 0) / px.length;
    const cy = px.reduce((s, p) => s + p.y, 0) / px.length;
    drawMoveHandle(cx, cy, moveActive);
  }
}

function drawZoneShape(pts, fill, stroke, dashed) {
  const px = pts.map(p => ({ x: p[0] * canvas.width, y: p[1] * canvas.height }));
  const cx = px.reduce((s, p) => s + p.x, 0) / px.length;
  const cy = px.reduce((s, p) => s + p.y, 0) / px.length;

  if (pts.length === CIRCLE_SEGS) {
    const r = px.reduce((s, p) => s + Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2), 0) / px.length;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = dashed ? 2.5 : 2;
    if (dashed) ctx.setLineDash([8, 4]);
    ctx.stroke(); ctx.setLineDash([]);
  } else {
    ctx.beginPath(); ctx.moveTo(px[0].x, px[0].y);
    px.forEach(p => ctx.lineTo(p.x, p.y)); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = dashed ? 2.5 : 2;
    if (dashed) ctx.setLineDash([8, 4]);
    ctx.stroke(); ctx.setLineDash([]);
  }
}

function drawMoveHandle(cx, cy, active) {
  const s = active ? 10 : 8;
  const gap = 3;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur  = 4;
  ctx.fillStyle   = active ? ROSE_STROKE : 'rgba(255,255,255,0.88)';
  ctx.beginPath(); ctx.roundRect(-s - gap, -s - gap, (s + gap) * 2, (s + gap) * 2, 5); ctx.fill();
  ctx.shadowBlur  = 0;
  ctx.strokeStyle = active ? '#fff' : ROSE_LABEL;
  ctx.fillStyle   = active ? '#fff' : ROSE_LABEL;
  ctx.lineWidth   = 2;
  ctx.lineCap     = 'round';
  ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(0, s); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-4, -s + 5); ctx.lineTo(0, -s); ctx.lineTo(4, -s + 5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-4, s - 5); ctx.lineTo(0, s); ctx.lineTo(4, s - 5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-s, 0); ctx.lineTo(s, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-s + 5, -4); ctx.lineTo(-s, 0); ctx.lineTo(-s + 5, 4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(s - 5, -4); ctx.lineTo(s, 0); ctx.lineTo(s - 5, 4); ctx.stroke();
  ctx.restore();
}

function drawLabel(text, cx, cy) {
  ctx.font = '600 13px -apple-system,system-ui,sans-serif';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath(); ctx.roundRect(cx - w / 2 - 6, cy - 10, w + 12, 20, 4); ctx.fill();
  ctx.fillStyle = ROSE_LABEL;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);
}

// ═════════════════════════════════════════════════════════════════════════════
// ZONES — chips with rule counts + inline delete confirmation
// ═════════════════════════════════════════════════════════════════════════════

function renderZoneList() {
  const wrap = document.getElementById('zonesList');
  wrap.innerHTML = '';
  Object.keys(savedZones).forEach(name => {
    const count = rules.filter(r => r.zone === name).length;

    const chip = document.createElement('div');
    chip.className = 'zone-chip';

    const nm = document.createElement('span');
    nm.className = 'chip-name';
    nm.textContent = name;
    chip.appendChild(nm);

    if (count > 0) {
      const ct = document.createElement('span');
      ct.className = 'chip-count';
      ct.textContent = count;
      ct.title = count === 1 ? '1 rule assigned' : `${count} rules assigned`;
      chip.appendChild(ct);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chip-del';
    del.textContent = '×';
    del.title = 'Delete zone';
    del.addEventListener('click', () => chip.classList.add('confirming'));
    chip.appendChild(del);

    const confirm = document.createElement('span');
    confirm.className = 'chip-confirm';
    const confirmText = document.createElement('span');
    confirmText.className = 'chip-confirm-text';
    confirmText.textContent = 'Delete?';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'chip-confirm-yes';
    yes.textContent = 'Delete';
    yes.addEventListener('click', () => deleteZone(name));
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'chip-confirm-no';
    no.textContent = 'Cancel';
    no.addEventListener('click', () => chip.classList.remove('confirming'));
    confirm.appendChild(confirmText);
    confirm.appendChild(yes);
    confirm.appendChild(no);
    chip.appendChild(confirm);

    wrap.appendChild(chip);
  });
}

// Zone deletion is cascaded server-side (rules_store.clear_zone_references) —
// any rule that referenced the deleted zone comes back with zone_name: null
// and zone_name_cleared: true, so we just reload rules from the backend.
function deleteZone(name) {
  fetch(`/zones/${encodeURIComponent(name)}`, { method: 'DELETE' })
    .then(r => r.json())
    .then(d => {
      if (!d.ok) return;
      delete savedZones[name];
      loadRules();
      renderZoneList();
      redraw();
    });
}

function clearAllZones() {
  Promise.all(
    Object.keys(savedZones).map(n => fetch(`/zones/${encodeURIComponent(n)}`, { method: 'DELETE' }))
  ).then(() => {
    savedZones = {};
    loadRules();
    renderZoneList();
    redraw();
  });
}

function loadZones() {
  fetch('/zones').then(r => r.json())
    .then(d => {
      savedZones = d.zones || {};
      renderZoneList();
      syncZoneSelect();
      redraw();
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// RULES — synced with the backend's shared rules_store (/rules), so the same
// rules and zone assignments are used by live monitoring and demo analysis.
// ═════════════════════════════════════════════════════════════════════════════

const RULE_LIBRARY = {
  'People':   ['Person enters the frame', 'Person loiters in view', 'Multiple people gathered', 'Person falls down', 'Person running'],
  'Objects':  ['Object left behind', 'Object removed from view', 'Unattended bag or package'],
  'Safety':   ['Person without a helmet', 'Smoke or fire detected', 'Door left open', 'Spill on the floor'],
  'Vehicles': ['Vehicle enters the driveway', 'Vehicle parked illegally', 'Vehicle reversing'],
};

function loadRules() {
  fetch('/rules').then(r => r.json()).then(d => {
    rules = (d.rules || []).map(r => ({
      id: r.id,
      text: r.rule_text,
      zone: r.zone_name,
      enabled: r.enabled,
      zoneCleared: r.zone_name_cleared,
    }));
    renderRules();
    renderZoneList();
    updateStartDisabled();
    renderDemoSources();
  }).catch(() => {});
}

function addRule(text, zone) {
  text = (text || '').trim();
  if (!text || monitoringActive) return;
  const zoneName = zone && savedZones[zone] ? zone : null;
  fetch('/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rule_text: text, zone_name: zoneName }),
  })
    .then(r => r.json())
    .then(d => { if (d.ok) loadRules(); });
}

function renderRules() {
  const list = document.getElementById('rulesList');
  list.innerHTML = '';
  if (rules.length === 0) {
    const p = document.createElement('p');
    p.className = 'rules-empty';
    p.textContent = 'No rules yet';
    list.appendChild(p);
  }
  rules.forEach(r => {
    const row = document.createElement('div');
    row.className = 'rule-row' + (r.enabled ? '' : ' disabled');

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'rule-check';
    check.checked = r.enabled;
    check.title = r.enabled ? 'Disable rule' : 'Enable rule';
    check.addEventListener('change', () => {
      fetch(`/rules/${encodeURIComponent(r.id)}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: check.checked }),
      }).then(() => loadRules());
    });

    const text = document.createElement('span');
    text.className = 'rule-text';
    text.textContent = r.text;
    text.title = r.text;

    row.appendChild(check);
    row.appendChild(text);

    if (r.zone) {
      const zb = document.createElement('span');
      zb.className = 'rule-zone';
      zb.textContent = r.zone;
      zb.title = r.zone;
      row.appendChild(zb);
    } else if (r.zoneCleared) {
      const wb = document.createElement('span');
      wb.className = 'rule-zone-warning';
      wb.textContent = 'Zone deleted — whole frame';
      wb.title = 'Its assigned zone was deleted; this rule now evaluates the whole frame.';
      row.appendChild(wb);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'rule-del';
    del.textContent = '×';
    del.title = 'Remove rule';
    del.addEventListener('click', () => {
      fetch(`/rules/${encodeURIComponent(r.id)}`, { method: 'DELETE' })
        .then(() => loadRules());
    });

    row.appendChild(del);
    list.appendChild(row);
  });
  syncZoneSelect();
}

function syncZoneSelect() {
  const sel = document.getElementById('zoneSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  const whole = document.createElement('option');
  whole.value = '';
  whole.textContent = 'Whole frame';
  sel.appendChild(whole);
  Object.keys(savedZones).forEach(name => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    sel.appendChild(o);
  });
  sel.value = prev && savedZones[prev] ? prev : '';
}

// composer
document.getElementById('addRuleBtn').addEventListener('click', () => {
  const input = document.getElementById('ruleInput');
  addRule(input.value, document.getElementById('zoneSelect').value);
  input.value = '';
  input.focus();
});

document.getElementById('ruleInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('addRuleBtn').click();
});

// rule library dropdown overlay
function renderRuleLibrary() {
  const lib = document.getElementById('ruleLibrary');
  lib.innerHTML = '';
  Object.entries(RULE_LIBRARY).forEach(([cat, items]) => {
    const h = document.createElement('div');
    h.className = 'library-category';
    h.textContent = cat;
    lib.appendChild(h);
    items.forEach(text => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'library-item';
      b.textContent = text;
      b.addEventListener('click', () => {
        addRule(text, document.getElementById('zoneSelect').value);
        toggleRuleLibrary(false);
      });
      lib.appendChild(b);
    });
  });
}

function toggleRuleLibrary(force) {
  const lib = document.getElementById('ruleLibrary');
  lib.hidden = typeof force === 'boolean' ? !force : !lib.hidden;
}

document.getElementById('ruleLibraryLink').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleRuleLibrary();
});

document.addEventListener('click', (e) => {
  const lib = document.getElementById('ruleLibrary');
  if (!lib.hidden && !lib.contains(e.target) && e.target.id !== 'ruleLibraryLink') {
    toggleRuleLibrary(false);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MONITORING + ALERTS
// ═════════════════════════════════════════════════════════════════════════════

let knownIds     = new Set();
let pollInterval = null;

function updateStartDisabled() {
  if (monitoringActive) return;
  document.getElementById('startBtn').disabled = rules.filter(r => r.enabled).length === 0;
}

// the backend's DetectorThread pulls enabled rules (with their own zone scoping)
// straight from the shared rules_store every cycle — the "rule" field here is
// just a required non-empty placeholder for the /start endpoint.
function startMonitoring() {
  if (rules.filter(r => r.enabled).length === 0) return;
  fetch('/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rule: 'multi-rule' }),
  }).then(() => { setMonitoringUI(true); startPolling(); });
}

function stopMonitoring() {
  fetch('/stop', { method: 'POST' }).then(() => setMonitoringUI(false));
}

function setMonitoringUI(active) {
  monitoringActive = active;
  document.getElementById('startBtn').hidden = active;
  document.getElementById('stopBtn').hidden = !active;
  document.getElementById('statusBadge').classList.toggle('active', active);
  document.getElementById('statusLabel').textContent = active ? 'Monitoring' : 'Idle';
  document.querySelector('.rules-card').classList.toggle('locked', active);
  if (!active) updateStartDisabled();
}

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(pollAlerts, 2000);
  pollAlerts();
}

function pollAlerts() {
  fetch('/alerts/json').then(r => r.json()).then(data => {
    // sync UI with backend state — monitoring may have been started/stopped elsewhere
    setMonitoringUI(!!data.monitoring);
    renderAlerts(data.alerts || []);
  }).catch(() => {});
}

function renderAlerts(alerts) {
  const list    = document.getElementById('alertsList');
  const empty   = document.getElementById('emptyState');
  const countEl = document.getElementById('alertCount');
  countEl.textContent = alerts.length;
  if (alerts.length === 0 && !list.querySelector('.alert-row')) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  const frag = document.createDocumentFragment();
  alerts.forEach(alert => {
    if (knownIds.has(alert.id)) return;
    knownIds.add(alert.id);

    const row = document.createElement('div');
    row.className = 'alert-row';

    const img = document.createElement('img');
    img.className = 'alert-thumb';
    img.src = alert.thumbnail;
    img.alt = 'Alert frame';
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(alert));

    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'alert-download';
    dl.textContent = '⬇';
    dl.title = 'Download image';
    dl.addEventListener('click', (e) => { e.stopPropagation(); downloadAlertImage(alert); });

    const body = document.createElement('div');
    body.className = 'alert-body';

    const expl = document.createElement('p');
    expl.className = 'alert-explanation';
    expl.textContent = alert.explanation || '';

    const meta = document.createElement('p');
    meta.className = 'alert-meta';
    meta.textContent = alertMetaText(alert);

    body.appendChild(expl);
    body.appendChild(meta);
    row.appendChild(img);
    row.appendChild(dl);
    row.appendChild(body);
    frag.appendChild(row);
  });
  if (frag.childNodes.length > 0) list.insertBefore(frag, list.firstChild);
}

function alertMetaText(alert) {
  const parts = [
    alert.rule,
    alert.zone,
    formatTime(alert.timestamp),
    `${Math.round((alert.confidence || 0) * 100)}%`,
  ].filter(Boolean);
  return parts.join(' · ');
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ═════════════════════════════════════════════════════════════════════════════
// ALERT IMAGE LIGHTBOX + DOWNLOAD
// ═════════════════════════════════════════════════════════════════════════════

const lightboxBackdropEl = document.getElementById('lightboxBackdrop');
const lightboxImgEl      = document.getElementById('lightboxImg');
const lightboxExplEl     = document.getElementById('lightboxExplanation');
const lightboxMetaEl     = document.getElementById('lightboxMeta');
let lightboxAlert = null;

function alertDownloadFilename(alert) {
  const d = new Date(alert.timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `openeye-alert-${stamp}.jpg`;
}

function downloadAlertImage(alert) {
  const a = document.createElement('a');
  a.href = alert.thumbnail;
  a.download = alertDownloadFilename(alert);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function openLightbox(alert) {
  lightboxAlert = alert;
  lightboxImgEl.src = alert.thumbnail;
  lightboxExplEl.textContent = alert.explanation || '';
  lightboxMetaEl.textContent = alertMetaText(alert);
  lightboxBackdropEl.hidden = false;
}

function closeLightbox() {
  lightboxBackdropEl.hidden = true;
  lightboxAlert = null;
}

lightboxBackdropEl.addEventListener('click', (e) => {
  if (e.target === lightboxBackdropEl) closeLightbox();
});

document.getElementById('lightboxCloseBtn').addEventListener('click', closeLightbox);

document.getElementById('lightboxDownloadBtn').addEventListener('click', () => {
  if (lightboxAlert) downloadAlertImage(lightboxAlert);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightboxBackdropEl.hidden) closeLightbox();
});

// ═════════════════════════════════════════════════════════════════════════════
// INIT
// ═════════════════════════════════════════════════════════════════════════════

renderRuleLibrary();
renderDemoSources();
loadZones();
loadRules();
startPolling();
