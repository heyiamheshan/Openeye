// ═══════════════════════════════════════════════════════════════════════════
// OpenEye — main.js
// Zone drawing flow:
//   1. "Draw Zone" freezes the live feed
//   2. User draws a shape (rect drag / poly clicks / circle drag)
//   3. Shape enters MOVE phase — drag it anywhere on the frozen frame
//   4. Name prompt appears below; user types a name and clicks Save
//   5. Zone is stored, live feed resumes
// ═══════════════════════════════════════════════════════════════════════════

// ── DOM refs ──────────────────────────────────────────────────────────────────
const feedImg  = document.getElementById('cameraFeed');
const canvas   = document.getElementById('zoneCanvas');
const ctx      = canvas.getContext('2d');
const drawBtn  = document.getElementById('drawZoneBtn');
const hintEl   = document.getElementById('drawHint');
const promptEl = document.getElementById('zoneNamePrompt');
const nameInput = document.getElementById('zoneNameInput');

const modeLive        = document.getElementById('modeLive');
const modeDemo        = document.getElementById('modeDemo');
const demoUploadEl    = document.getElementById('demoUpload');
const demoVideoInput  = document.getElementById('demoVideoInput');
const demoUploadHint  = document.getElementById('demoUploadHint');

// ── constants ─────────────────────────────────────────────────────────────────
const AMBER_FILL        = 'rgba(245,158,11,0.22)';
const AMBER_FILL_MOVE   = 'rgba(245,158,11,0.32)';  // slightly brighter while moving
const AMBER_STROKE      = '#F59E0B';
const AMBER_LABEL       = '#92400E';
const HANDLE_R          = 6;
const HANDLE_HIT_R      = 10;
const RESIZE_MIN        = 0.02;   // min normalised rect size
const CIRCLE_SEGS       = 48;

// ── phase ─────────────────────────────────────────────────────────────────────
// 'idle' | 'draw' | 'move' | 'name'
let phase     = 'idle';
let drawMode  = 'rect';   // 'rect' | 'poly' | 'circle'

// ── pending zone (normalised [[x,y]…]) ────────────────────────────────────────
let pendingPoly = null;

// ── saved zones ───────────────────────────────────────────────────────────────
let savedZones = {};      // name → [[x,y]…] normalised

// ── draw-phase state ──────────────────────────────────────────────────────────
let rectStart    = null;
let rectCur      = null;
let polyPts      = [];
let mousePos     = null;
let circleCenter = null;
let circleEdge   = null;

// ── move-phase state ──────────────────────────────────────────────────────────
let moveActive  = false;    // mouse is held during move
let moveLast    = null;     // last {x,y} in pixels during drag
let activeHandle = null;    // resize handle currently being dragged, if any

// ── canvas sizing ─────────────────────────────────────────────────────────────
function syncCanvasSize() {
  const r = canvas.getBoundingClientRect();
  if (r.width === 0) return;
  canvas.width  = r.width;
  canvas.height = r.height;
  redraw();
}
new ResizeObserver(syncCanvasSize).observe(canvas);

// ── live feed helpers ─────────────────────────────────────────────────────────
let frozenFrameImg = null;
let frozenFrameUrl = null;

function freezeFeed() {
  const r = canvas.getBoundingClientRect();
  canvas.width  = r.width;
  canvas.height = r.height;
  canvas.closest('.camera-frame').classList.add('freeze');

  fetch('/current_frame')
    .then(res => { if (!res.ok) throw new Error('bad response'); return res.blob(); })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        if (frozenFrameUrl) URL.revokeObjectURL(frozenFrameUrl);
        frozenFrameImg = img;
        frozenFrameUrl = url;
        redraw();
      };
      img.src = url;
    })
    .catch(() => {
      // fallback: snapshot whatever the live <img> last rendered
      try {
        const tmp = document.createElement('canvas');
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        tmp.getContext('2d').drawImage(feedImg, 0, 0, canvas.width, canvas.height);
        const img = new Image();
        img.onload = () => { frozenFrameImg = img; redraw(); };
        img.src = tmp.toDataURL('image/jpeg');
      } catch (_) {
        frozenFrameImg = null;
        redraw();
      }
    });

  feedImg.dataset.liveSrc = feedImg.src;
  feedImg.src = '';
}

function resumeFeed() {
  feedImg.src = feedImg.dataset.liveSrc || '/video_feed';
  canvas.closest('.camera-frame').classList.remove('freeze');
  if (frozenFrameUrl) { URL.revokeObjectURL(frozenFrameUrl); frozenFrameUrl = null; }
  frozenFrameImg = null;
}

// ── public: toggle draw mode button ──────────────────────────────────────────
function toggleDrawMode() {
  if (phase !== 'idle') { cancelDraw(); } else { enterDraw(); }
}

function enterDraw() {
  phase = 'draw';
  rectStart = rectCur = null;
  polyPts   = [];
  mousePos  = null;
  pendingPoly = null;
  circleCenter = circleEdge = null;
  moveActive = false; moveLast = null; activeHandle = null;
  promptEl.classList.remove('visible');

  drawMode = (document.querySelector('input[name="drawMode"]:checked') || {}).value || 'rect';

  freezeFeed();

  drawBtn.classList.add('btn-draw-active');
  drawBtn.textContent = 'Cancel';
  canvas.classList.add('drawing');

  const hints = {
    rect:   'Click and drag to draw a rectangle zone',
    poly:   'Click to place vertices · Double-click or click first point to close',
    circle: 'Click the centre, drag to set radius',
  };
  setHint(hints[drawMode] || '');
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
  moveActive = false; moveLast = null; activeHandle = null;

  drawBtn.classList.remove('btn-draw-active');
  drawBtn.textContent = 'Draw Zone';
  canvas.classList.remove('drawing', 'moving');
  promptEl.classList.remove('visible');
  setHint('');

  resumeFeed();
  syncCanvasSize();
}

function setHint(msg) { hintEl.textContent = msg; }

// ── canvas mouse handlers ─────────────────────────────────────────────────────
canvas.addEventListener('mousedown', (e) => {
  if (phase === 'idle') return;
  const p = evPt(e);

  if (phase === 'draw') {
    if (drawMode === 'rect')   { rectStart = p; rectCur = p; }
    if (drawMode === 'circle') { circleCenter = p; circleEdge = p; }
  }

  if (phase === 'move' || phase === 'name') {
    const handle = hitTestHandle(p);
    if (handle && handle.type === 'vmid') {
      // click a midpoint handle → insert a new vertex there, then drag it
      const idx = handle.insertIndex;
      pendingPoly.splice(idx, 0, [handle.x / canvas.width, handle.y / canvas.height]);
      activeHandle = {
        cursor: 'move',
        apply: (pp) => { pendingPoly[idx] = [pp.x / canvas.width, pp.y / canvas.height]; },
      };
      moveActive = true;
      moveLast   = p;
      canvas.classList.add('grabbing');
    } else if (handle) {
      activeHandle = handle;
      moveActive   = true;
      moveLast     = p;
      canvas.classList.add('grabbing');
    } else if (pointInPendingPoly(p)) {
      activeHandle = null;
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
    if (activeHandle) {
      activeHandle.apply(p);
    } else {
      const dx = (p.x - moveLast.x) / canvas.width;
      const dy = (p.y - moveLast.y) / canvas.height;
      pendingPoly = pendingPoly.map(([nx, ny]) => [nx + dx, ny + dy]);
    }
    moveLast = p;
  }

  // update cursor in move/name phase
  if (phase === 'move' || phase === 'name') {
    if (moveActive) {
      canvas.style.cursor = activeHandle ? (activeHandle.cursor || 'grabbing') : 'grabbing';
    } else {
      const handle = hitTestHandle(p);
      canvas.style.cursor = handle ? handle.cursor : (pointInPendingPoly(p) ? 'grab' : 'default');
    }
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
    activeHandle = null;
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

// Ray-cast hit-test against pendingPoly (pixel coords)
function pointInPendingPoly(p) {
  if (!pendingPoly || pendingPoly.length < 3) return false;
  const pts = pendingPoly.map(([nx, ny]) => ({ x: nx*canvas.width, y: ny*canvas.height }));
  // For circles (48 pts) also accept hits within the bounding radius
  if (pendingPoly.length === CIRCLE_SEGS) {
    const cx = pts.reduce((s,q)=>s+q.x,0)/pts.length;
    const cy = pts.reduce((s,q)=>s+q.y,0)/pts.length;
    const r  = pts.reduce((s,q)=>s+Math.sqrt((q.x-cx)**2+(q.y-cy)**2),0)/pts.length;
    return Math.sqrt((p.x-cx)**2+(p.y-cy)**2) <= r;
  }
  // Standard ray-cast for rect / poly
  let inside = false, j = pts.length - 1;
  for (let i = 0; i < pts.length; i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < (xj-xi)*(p.y-yi)/(yj-yi+1e-12)+xi) inside = !inside;
    j = i;
  }
  return inside;
}

// ── resize handles ───────────────────────────────────────────────────────────
function getHandles() {
  if (!pendingPoly) return [];
  if (drawMode === 'rect' && pendingPoly.length === 4) return getRectHandles();
  if (drawMode === 'circle' && pendingPoly.length === CIRCLE_SEGS) return getCircleHandles();
  if (drawMode === 'poly') return getPolyHandles();
  return [];
}

function hitTestHandle(p) {
  for (const h of getHandles()) {
    const dx = p.x - h.x, dy = p.y - h.y;
    if (Math.sqrt(dx*dx + dy*dy) <= HANDLE_HIT_R) return h;
  }
  return null;
}

function getRectHandles() {
  const xs = pendingPoly.map(pt => pt[0]);
  const ys = pendingPoly.map(pt => pt[1]);
  const x1 = Math.min(...xs), x2 = Math.max(...xs);
  const y1 = Math.min(...ys), y2 = Math.max(...ys);
  const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
  const toPx = (nx, ny) => ({ x: nx * canvas.width, y: ny * canvas.height });
  const norm = (p) => [p.x / canvas.width, p.y / canvas.height];
  const setRect = (nx1, ny1, nx2, ny2) => { pendingPoly = [[nx1,ny1],[nx2,ny1],[nx2,ny2],[nx1,ny2]]; };

  return [
    { ...toPx(x1, y1), cursor: 'nwse-resize', apply: (p) => { const [nx,ny]=norm(p); setRect(Math.min(nx,x2-RESIZE_MIN), Math.min(ny,y2-RESIZE_MIN), x2, y2); } },
    { ...toPx(x2, y1), cursor: 'nesw-resize', apply: (p) => { const [nx,ny]=norm(p); setRect(x1, Math.min(ny,y2-RESIZE_MIN), Math.max(nx,x1+RESIZE_MIN), y2); } },
    { ...toPx(x2, y2), cursor: 'nwse-resize', apply: (p) => { const [nx,ny]=norm(p); setRect(x1, y1, Math.max(nx,x1+RESIZE_MIN), Math.max(ny,y1+RESIZE_MIN)); } },
    { ...toPx(x1, y2), cursor: 'nesw-resize', apply: (p) => { const [nx,ny]=norm(p); setRect(Math.min(nx,x2-RESIZE_MIN), y1, x2, Math.max(ny,y1+RESIZE_MIN)); } },
    { ...toPx(midX, y1), cursor: 'n-resize', apply: (p) => { const [,ny]=norm(p); setRect(x1, Math.min(ny,y2-RESIZE_MIN), x2, y2); } },
    { ...toPx(x2, midY), cursor: 'e-resize', apply: (p) => { const [nx]=norm(p); setRect(x1, y1, Math.max(nx,x1+RESIZE_MIN), y2); } },
    { ...toPx(midX, y2), cursor: 's-resize', apply: (p) => { const [,ny]=norm(p); setRect(x1, y1, x2, Math.max(ny,y1+RESIZE_MIN)); } },
    { ...toPx(x1, midY), cursor: 'w-resize', apply: (p) => { const [nx]=norm(p); setRect(Math.min(nx,x2-RESIZE_MIN), y1, x2, y2); } },
  ];
}

function getCircleHandles() {
  const px = pendingPoly.map(p => ({ x: p[0]*canvas.width, y: p[1]*canvas.height }));
  const cx = px.reduce((s,p)=>s+p.x,0)/px.length;
  const cy = px.reduce((s,p)=>s+p.y,0)/px.length;
  const r  = px.reduce((s,p)=>s+Math.sqrt((p.x-cx)**2+(p.y-cy)**2),0)/px.length;

  const rebuild = (newR) => {
    const rr = Math.max(newR, 8);
    pendingPoly = Array.from({ length: CIRCLE_SEGS }, (_, i) => {
      const a = (i / CIRCLE_SEGS) * Math.PI * 2;
      return [(cx + Math.cos(a)*rr)/canvas.width, (cy + Math.sin(a)*rr)/canvas.height];
    });
  };

  return [
    { x: cx + r, y: cy,     cursor: 'e-resize', apply: (p) => rebuild(Math.abs(p.x - cx)) },
    { x: cx,     y: cy + r, cursor: 's-resize', apply: (p) => rebuild(Math.abs(p.y - cy)) },
    { x: cx - r, y: cy,     cursor: 'w-resize', apply: (p) => rebuild(Math.abs(p.x - cx)) },
    { x: cx,     y: cy - r, cursor: 'n-resize', apply: (p) => rebuild(Math.abs(p.y - cy)) },
  ];
}

function getPolyHandles() {
  if (!pendingPoly || pendingPoly.length < 3) return [];
  const px = pendingPoly.map(p => ({ x: p[0]*canvas.width, y: p[1]*canvas.height }));
  const handles = [];

  px.forEach((pt, i) => {
    handles.push({
      x: pt.x, y: pt.y, cursor: 'move', type: 'vertex',
      apply: (p) => { pendingPoly[i] = [p.x / canvas.width, p.y / canvas.height]; },
    });
  });

  px.forEach((pt, i) => {
    const next = px[(i + 1) % px.length];
    handles.push({
      x: (pt.x + next.x) / 2, y: (pt.y + next.y) / 2,
      cursor: 'copy', type: 'vmid', insertIndex: i + 1,
    });
  });

  return handles;
}

function drawHandles() {
  getHandles().forEach(h => {
    const size = h.type === 'vmid' ? 6 : 8;
    ctx.beginPath();
    ctx.rect(h.x - size/2, h.y - size/2, size, size);
    ctx.fillStyle = h.type === 'vmid' ? 'rgba(255,255,255,0.65)' : '#fff';
    ctx.fill();
    ctx.strokeStyle = AMBER_STROKE;
    ctx.lineWidth = h.type === 'vmid' ? 1 : 1.5;
    ctx.stroke();
  });
}

// ── finish drawing → enter move phase ─────────────────────────────────────────
function finishRect() {
  const x1 = Math.min(rectStart.x, rectCur.x) / canvas.width;
  const y1 = Math.min(rectStart.y, rectCur.y) / canvas.height;
  const x2 = Math.max(rectStart.x, rectCur.x) / canvas.width;
  const y2 = Math.max(rectStart.y, rectCur.y) / canvas.height;
  pendingPoly = [[x1,y1],[x2,y1],[x2,y2],[x1,y2]];
  rectStart = rectCur = null;
  enterMove();
  showNamePrompt();
}

function finishPoly() {
  pendingPoly = polyPts.map(p => [p.x/canvas.width, p.y/canvas.height]);
  polyPts = [];
  enterMove();
  showNamePrompt();
}

function finishCircle() {
  const cx = circleCenter.x, cy = circleCenter.y;
  const dx = circleEdge.x - cx, dy = circleEdge.y - cy;
  const r  = Math.sqrt(dx*dx + dy*dy);
  pendingPoly = Array.from({ length: CIRCLE_SEGS }, (_, i) => {
    const a = (i / CIRCLE_SEGS) * Math.PI * 2;
    return [(cx + Math.cos(a)*r)/canvas.width, (cy + Math.sin(a)*r)/canvas.height];
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

  if (frozenFrameImg && phase !== 'idle') {
    ctx.drawImage(frozenFrameImg, 0, 0, canvas.width, canvas.height);
  }

  // saved zones
  for (const [name, pts] of Object.entries(savedZones)) {
    drawZoneShape(pts, AMBER_FILL, AMBER_STROKE, false);
    const px = pts.map(p => ({ x: p[0]*canvas.width, y: p[1]*canvas.height }));
    const cx = px.reduce((s,p)=>s+p.x,0)/px.length;
    const cy = px.reduce((s,p)=>s+p.y,0)/px.length;
    drawLabel(name, cx, cy);
  }

  if (phase === 'idle') return;

  // ── draw phase previews ────────────────────────────────────────────────────
  if (phase === 'draw') {
    if (drawMode === 'rect' && rectStart && rectCur) {
      const x = Math.min(rectStart.x, rectCur.x);
      const y = Math.min(rectStart.y, rectCur.y);
      const w = Math.abs(rectCur.x - rectStart.x);
      const h = Math.abs(rectCur.y - rectStart.y);
      ctx.fillStyle = AMBER_FILL; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = AMBER_STROKE; ctx.lineWidth = 2;
      ctx.setLineDash([6,3]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
    }

    if (drawMode === 'poly' && polyPts.length > 0) {
      ctx.beginPath();
      ctx.moveTo(polyPts[0].x, polyPts[0].y);
      polyPts.forEach(p => ctx.lineTo(p.x, p.y));
      if (mousePos) ctx.lineTo(mousePos.x, mousePos.y);
      ctx.strokeStyle = AMBER_STROKE; ctx.lineWidth = 2;
      ctx.setLineDash([6,3]); ctx.stroke(); ctx.setLineDash([]);
      polyPts.forEach((p, i) => {
        ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI*2);
        ctx.fillStyle = i === 0 ? AMBER_STROKE : '#fff';
        ctx.strokeStyle = AMBER_STROKE; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
      });
      if (polyPts.length >= 3) {
        ctx.beginPath(); ctx.arc(polyPts[0].x, polyPts[0].y, HANDLE_R+5, 0, Math.PI*2);
        ctx.strokeStyle = 'rgba(245,158,11,0.4)'; ctx.lineWidth = 2; ctx.stroke();
      }
    }

    if (drawMode === 'circle' && circleCenter) {
      const edge = circleEdge || mousePos || circleCenter;
      const dx = edge.x - circleCenter.x, dy = edge.y - circleCenter.y;
      const r = Math.sqrt(dx*dx + dy*dy);
      ctx.beginPath(); ctx.arc(circleCenter.x, circleCenter.y, Math.max(r,1), 0, Math.PI*2);
      ctx.fillStyle = AMBER_FILL; ctx.fill();
      ctx.strokeStyle = AMBER_STROKE; ctx.lineWidth = 2;
      ctx.setLineDash([6,3]); ctx.stroke(); ctx.setLineDash([]);
      if (r > 8) {
        ctx.beginPath(); ctx.moveTo(circleCenter.x, circleCenter.y); ctx.lineTo(edge.x, edge.y);
        ctx.strokeStyle = 'rgba(245,158,11,0.5)'; ctx.lineWidth = 1;
        ctx.setLineDash([4,4]); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.beginPath(); ctx.arc(circleCenter.x, circleCenter.y, HANDLE_R, 0, Math.PI*2);
      ctx.fillStyle = AMBER_STROKE; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
    }
  }

  // ── move / name phase: pending zone ───────────────────────────────────────
  if ((phase === 'move' || phase === 'name') && pendingPoly) {
    const isMoving = moveActive;
    drawZoneShape(pendingPoly, isMoving ? AMBER_FILL_MOVE : AMBER_FILL, AMBER_STROKE, true);

    // move handle: 4-arrow icon at centroid
    const px  = pendingPoly.map(p => ({ x: p[0]*canvas.width, y: p[1]*canvas.height }));
    const cx  = px.reduce((s,p)=>s+p.x,0)/px.length;
    const cy  = px.reduce((s,p)=>s+p.y,0)/px.length;

    // draw move icon (cross-arrows) at centroid
    drawMoveHandle(cx, cy, isMoving);

    // resize handles (hidden once the zone is saved / phase leaves move-name)
    drawHandles();
  }
}

// Draw a zone shape (circle-smooth or polygon) at normalised coords
function drawZoneShape(pts, fill, stroke, dashed) {
  const px = pts.map(p => ({ x: p[0]*canvas.width, y: p[1]*canvas.height }));
  const cx = px.reduce((s,p)=>s+p.x,0)/px.length;
  const cy = px.reduce((s,p)=>s+p.y,0)/px.length;

  if (pts.length === CIRCLE_SEGS) {
    const r = px.reduce((s,p)=>s+Math.sqrt((p.x-cx)**2+(p.y-cy)**2),0)/px.length;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = dashed ? 2.5 : 2;
    if (dashed) ctx.setLineDash([8,4]);
    ctx.stroke(); ctx.setLineDash([]);
  } else {
    ctx.beginPath(); ctx.moveTo(px[0].x, px[0].y);
    px.forEach(p => ctx.lineTo(p.x, p.y)); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = dashed ? 2.5 : 2;
    if (dashed) ctx.setLineDash([8,4]);
    ctx.stroke(); ctx.setLineDash([]);
  }
}

// Draw a small move-handle cross-arrows icon
function drawMoveHandle(cx, cy, active) {
  const s = active ? 10 : 8;
  const gap = 3;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = active ? '#fff' : AMBER_STROKE;
  ctx.fillStyle   = active ? AMBER_STROKE : '#fff';
  ctx.lineWidth   = 2;
  ctx.lineCap     = 'round';

  // draw a small rounded rect background
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur  = 4;
  ctx.fillStyle   = active ? AMBER_STROKE : 'rgba(255,255,255,0.88)';
  ctx.beginPath(); ctx.roundRect(-s-gap, -s-gap, (s+gap)*2, (s+gap)*2, 5); ctx.fill();
  ctx.shadowBlur  = 0;

  // draw ↕ and ↔ arrows
  ctx.strokeStyle = active ? '#fff' : AMBER_LABEL;
  ctx.lineWidth   = 2;
  // vertical
  ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(0, s); ctx.stroke();
  // up arrowhead
  ctx.beginPath(); ctx.moveTo(-4, -s+5); ctx.lineTo(0, -s); ctx.lineTo(4, -s+5); ctx.stroke();
  // down arrowhead
  ctx.beginPath(); ctx.moveTo(-4, s-5); ctx.lineTo(0, s); ctx.lineTo(4, s-5); ctx.stroke();
  // horizontal
  ctx.beginPath(); ctx.moveTo(-s, 0); ctx.lineTo(s, 0); ctx.stroke();
  // left arrowhead
  ctx.beginPath(); ctx.moveTo(-s+5, -4); ctx.lineTo(-s, 0); ctx.lineTo(-s+5, 4); ctx.stroke();
  // right arrowhead
  ctx.beginPath(); ctx.moveTo(s-5, -4); ctx.lineTo(s, 0); ctx.lineTo(s-5, 4); ctx.stroke();

  ctx.restore();
}

function drawLabel(text, cx, cy) {
  ctx.font = '600 13px -apple-system,system-ui,sans-serif';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.beginPath(); ctx.roundRect(cx - w/2 - 6, cy - 10, w + 12, 20, 4); ctx.fill();
  ctx.fillStyle = AMBER_LABEL;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);
}

function fillPoly(pts, fill, stroke, lw) {
  if (pts.length < 2) return;
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
  pts.forEach(p => ctx.lineTo(p.x, p.y)); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke();
}

// ── zone list ─────────────────────────────────────────────────────────────────
function renderZoneList() {
  const list  = document.getElementById('zonesList');
  const names = Object.keys(savedZones);
  if (names.length === 0) {
    list.innerHTML = '<p class="zones-empty" id="zonesEmpty">No zones defined yet.</p>';
    return;
  }
  list.innerHTML = '';
  names.forEach(name => {
    const item = document.createElement('div');
    item.className = 'zone-item';
    item.innerHTML = `
      <span class="zone-dot"></span>
      <span class="zone-name">${escapeHtml(name)}</span>
      <button class="btn-sm btn-danger" onclick="deleteZone(${JSON.stringify(name)})">Delete</button>
    `;
    list.appendChild(item);
  });
}

function deleteZone(name) {
  fetch(`/zones/${encodeURIComponent(name)}`, { method: 'DELETE' })
    .then(r => r.json())
    .then(d => { if (d.ok) { delete savedZones[name]; redraw(); renderZoneList(); } });
}

function clearAllZones() {
  Promise.all(
    Object.keys(savedZones).map(n => fetch(`/zones/${encodeURIComponent(n)}`, { method: 'DELETE' }))
  ).then(() => { savedZones = {}; redraw(); renderZoneList(); });
}

function loadZones() {
  fetch('/zones').then(r => r.json())
    .then(d => { savedZones = d.zones || {}; syncCanvasSize(); renderZoneList(); });
}

// ── monitoring ────────────────────────────────────────────────────────────────
let knownIds     = new Set();
let pollInterval = null;

function startMonitoring() {
  const rule = document.getElementById('ruleInput').value.trim();
  if (!rule) { document.getElementById('ruleInput').focus(); return; }
  fetch('/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rule }),
  }).then(() => { setMonitoringUI(true); startPolling(); });
}

function stopMonitoring() {
  fetch('/stop', { method: 'POST' }).then(() => setMonitoringUI(false));
}

function setMonitoringUI(active) {
  document.getElementById('startBtn').disabled  = active;
  document.getElementById('stopBtn').disabled   = !active;
  document.getElementById('ruleInput').readOnly = active;
  const dot   = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  const badge = document.getElementById('statusBadge');
  dot.className     = active ? 'status-dot active' : 'status-dot';
  label.textContent = active ? 'Monitoring' : 'Idle';
  badge.className   = active ? 'status-badge status-active' : 'status-badge';
}

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(pollAlerts, 2000);
  pollAlerts();
}

function pollAlerts() {
  fetch('/alerts/json').then(r => r.json()).then(data => {
    if (!data.monitoring) { setMonitoringUI(false); clearInterval(pollInterval); pollInterval = null; }
    renderAlerts(data.alerts);
  }).catch(() => {});
}

function renderAlerts(alerts) {
  const list    = document.getElementById('alertsList');
  const empty   = document.getElementById('emptyState');
  const countEl = document.getElementById('alertCount');
  countEl.textContent = alerts.length;
  if (alerts.length === 0) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  alerts.forEach(alert => {
    if (knownIds.has(alert.id)) return;
    knownIds.add(alert.id);
    const card = document.createElement('div');
    card.className = 'alert-card';
    const zoneBadge = alert.zone ? `<span class="zone-badge">${escapeHtml(alert.zone)}</span>` : '';
    card.innerHTML = `
      <img class="alert-thumb" src="${alert.thumbnail}" alt="Alert frame" loading="lazy" />
      <div class="alert-body">
        <div class="alert-meta">
          <time class="alert-time">${formatTime(alert.timestamp)}</time>
          <div style="display:flex;gap:4px;align-items:center">
            ${zoneBadge}
            <span class="confidence-badge">${Math.round(alert.confidence*100)}%</span>
          </div>
        </div>
        <p class="alert-explanation">${escapeHtml(alert.explanation)}</p>
        <p class="alert-rule">${escapeHtml(alert.rule)}</p>
      </div>`;
    const first = list.querySelector('.alert-card');
    if (first) list.insertBefore(card, first); else list.appendChild(card);
  });
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML;
}

// ── demo mode ─────────────────────────────────────────────────────────────────
function onFeedModeChange() {
  const demo = modeDemo.checked;
  demoUploadEl.classList.toggle('visible', demo);
  fetch('/demo_mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ demo_mode: demo }),
  }).catch(() => {});
}

modeLive.addEventListener('change', onFeedModeChange);
modeDemo.addEventListener('change', onFeedModeChange);

function uploadDemoVideo() {
  const file = demoVideoInput.files[0];
  if (!file) { demoUploadHint.textContent = 'Choose a file first'; return; }

  const form = new FormData();
  form.append('video', file);
  demoUploadHint.textContent = 'Uploading…';

  fetch('/upload_video', { method: 'POST', body: form })
    .then(r => r.json())
    .then(d => {
      demoUploadHint.textContent = d.ok ? 'Uploaded ✓' : (d.error || 'Upload failed');
    })
    .catch(() => { demoUploadHint.textContent = 'Upload failed'; });
}

function loadDemoState() {
  fetch('/demo_mode').then(r => r.json()).then(d => {
    modeLive.checked = !d.demo_mode;
    modeDemo.checked = d.demo_mode;
    demoUploadEl.classList.toggle('visible', d.demo_mode);
  }).catch(() => {});
}

// ── init ──────────────────────────────────────────────────────────────────────
loadZones();
loadDemoState();
startPolling();
