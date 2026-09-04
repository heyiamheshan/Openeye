// ═══════════════════════════════════════════════════════════════════════════
// OpenEye — main.js
// Feed: live MJPEG, a procedurally animated demo scene rendered on a hidden
// 1280×720 canvas and streamed into a <video> via captureStream(30), or an
// uploaded clip that replaces the scene (backend analyzes it after upload).
// Zone drawing: Draw zone freezes the feed → draw a shape (rect/poly/circle)
// → drag to reposition → name it → persisted to the backend.
// Rules: synced with the backend store; enabled rules are combined into one
// rule string ("text in the zone zone") and POSTed to /start.
// Alerts: polled from /alerts/json every 2s with severity badges; new alerts
// animate in. Shift Digest: /digest/json + /digest/ai. History: /incidents.
// ═══════════════════════════════════════════════════════════════════════════

// ── DOM refs ──────────────────────────────────────────────────────────────────
const feedImg       = document.getElementById('cameraFeed');
const demoVideo     = document.getElementById('demoVideo');
const sceneCanvas   = document.getElementById('demoSceneCanvas');
const sceneCtx      = sceneCanvas.getContext('2d');
const canvas        = document.getElementById('zoneCanvas');
const ctx           = canvas.getContext('2d');
const drawBtn       = document.getElementById('drawZoneBtn');
const hintEl        = document.getElementById('drawHint');
const promptEl      = document.getElementById('zoneNamePrompt');
const nameInput     = document.getElementById('zoneNameInput');
const frameEl       = document.getElementById('cameraFrame');
const frozenFrameEl = document.getElementById('frozenFrame');
const cameraOverlayEl = document.getElementById('cameraOverlay');
const feedTagEl       = document.getElementById('feedTag');
const feedTagTextEl   = document.getElementById('feedTagText');

const startBtn   = document.getElementById('startBtn');
const stopBtn    = document.getElementById('stopBtn');
const uploadVideoBtn = document.getElementById('uploadVideoBtn');
const useSampleBtn   = document.getElementById('useSampleBtn');
const sampleSceneBtn = document.getElementById('sampleSceneBtn');
const videoFileInput = document.getElementById('videoFileInput');
const statusBadgeEl = document.getElementById('statusBadge');
const statusLabelEl = document.getElementById('statusLabel');

const zonesListEl = document.getElementById('zonesList');
const zonesSubEl  = document.getElementById('zonesSub');

const rulesCardEl  = document.getElementById('rulesCard');
const rulesListEl  = document.getElementById('rulesList');
const rulesSubEl   = document.getElementById('rulesSub');
const ruleInputEl  = document.getElementById('ruleInput');
const zoneSelectEl = document.getElementById('zoneSelect');
const addRuleBtnEl = document.getElementById('addRuleBtn');

const alertCountEl = document.getElementById('alertCount');
const alertsListEl = document.getElementById('alertsList');

const digestHeaderBtnEl = document.getElementById('digestHeaderBtn');
const digestBodyEl      = document.getElementById('digestBody');
const digestChevronEl   = document.getElementById('digestChevron');
const digestSubtitleEl  = document.getElementById('digestSubtitle');
const digestStatsEl     = document.getElementById('digestStats');
const generateDigestBtn = document.getElementById('generateDigestBtn');
const aiDigestCardEl    = document.getElementById('aiDigestCard');
const aiDigestSubtitleEl = document.getElementById('aiDigestSubtitle');
const aiDigestResultEl  = document.getElementById('aiDigestResult');

digestHeaderBtnEl.addEventListener('click', () => {
  const expanding = digestBodyEl.hidden;
  digestBodyEl.hidden = !expanding;
  digestChevronEl.textContent = expanding ? '▲' : '▼';
});

const dashboardViewEl = document.getElementById('dashboardView');
const historyViewEl   = document.getElementById('historyView');
const historyRangeEl  = document.getElementById('historyRange');
const severityChipsEl = document.getElementById('severityChips');
const zoneChipsEl     = document.getElementById('zoneChips');
const historyListEl   = document.getElementById('historyList');
const historyCountEl  = document.getElementById('historyCount');

const lightboxBackdropEl = document.getElementById('lightboxBackdrop');
const lightboxImgEl      = document.getElementById('lightboxImg');
const lightboxExplEl     = document.getElementById('lightboxExplanation');
const lightboxMetaEl     = document.getElementById('lightboxMeta');

const toastEl = document.getElementById('toast');

// ── constants ─────────────────────────────────────────────────────────────────
const ACCENT        = '#E11D48';
const ZONE_FILL         = 'rgba(225,29,72,0.14)';   // in-progress draw preview
const ZONE_FILL_MOVE    = 'rgba(225,29,72,0.22)';
const ZONE_STROKE       = '#FDA4AF';                // accent-300
const ZONE_SAVED_FILL   = 'rgba(225,29,72,0.26)';   // saved zones — bolder
const ZONE_SAVED_STROKE = '#E11D48';
const HANDLE_R    = 6;
const CIRCLE_SEGS = 48;      // circles are stored as 48-point polygon approximations
const DEMO_W      = 1280;
const DEMO_H      = 720;

const SEVERITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

// ── state ─────────────────────────────────────────────────────────────────────
let currentView = 'dashboard';        // 'dashboard' | 'history'
let feedMode    = 'live';             // 'live' | 'demo'
let phase       = 'idle';             // 'idle' | 'draw' | 'move' | 'name'
let drawMode    = 'rect';             // 'rect' | 'poly' | 'circle'
let pendingPoly = null;               // normalised [[x,y]…] of the zone being drawn
let pendingShapeType = null;
let savedZones  = {};                 // name → [[x,y]…] normalised
let rules       = [];                 // synced from backend
let monitoringActive = false;
let demoSourceReady  = false;         // backend has a demo video loaded to analyze
let customDemoUrl    = null;          // uploaded clip overriding the animated scene
let customDemoIsBlob = false;         // blob URLs must be revoked; server URLs must not

// draw-phase state
let rectStart = null, rectCur = null;
let polyPts = [], mousePos = null;
let circleCenter = null, circleEdge = null;

// move-phase state
let moveActive = false, moveLast = null;
let resizeMode = null, resizeCornerIndex = -1, resizeAnchor = null, resizeCenterPx = null;

// ── utilities ─────────────────────────────────────────────────────────────────
function fetchJson(url, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  return fetch(url, init).then(r => r.json());
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// matches the backend's naive local-time ISO timestamps
function localIso(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function localIsoHoursAgo(hours) {
  return localIso(new Date(Date.now() - hours * 3600 * 1000));
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) +
         ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function confidencePct(c) {
  return `${Math.round((c || 0) * 100)}%`;
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3400);
}

// ═════════════════════════════════════════════════════════════════════════════
// VIEW SWITCHING — Dashboard / History
// ═════════════════════════════════════════════════════════════════════════════

function switchView(view) {
  if (view === currentView) return;
  currentView = view;
  const isHistory = view === 'history';
  dashboardViewEl.hidden = isHistory;
  historyViewEl.hidden = !isHistory;
  document.querySelectorAll('#mainNav .nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.view === view);
  });
  if (isHistory) {
    renderHistoryZoneChips();
    loadHistory();
  }
  window.scrollTo({ top: 0 });
}

document.querySelectorAll('#mainNav .nav-link').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    switchView(link.dataset.view);
  });
});

document.getElementById('backToDashboard').addEventListener('click', () => switchView('dashboard'));

// ═════════════════════════════════════════════════════════════════════════════
// DEMO SCENE — procedurally animated warehouse floor, drawn onto the hidden
// 1280×720 #demoSceneCanvas and streamed into #demoVideo via captureStream(30).
// ═════════════════════════════════════════════════════════════════════════════

let demoRafId = null;
let demoLastTs = null;
let demoClock = 0;

const demoWorkers = [
  { x: 190,  y: 588, dir:  1, speed: 46, scale: 1.18, vest: '#F97316', helmet: true,  phase: 0.0, min: 110, max: 560 },
  { x: 640,  y: 648, dir: -1, speed: 58, scale: 1.34, vest: '#FBBF24', helmet: true,  phase: 2.1, min: 240, max: 900 },
  { x: 1010, y: 566, dir:  1, speed: 38, scale: 1.08, vest: '#F97316', helmet: false, phase: 4.2, min: 660, max: 1180 },
];

const demoBoxes = [
  { base: 0,   w: 36, h: 26 },
  { base: 190, w: 42, h: 30 },
  { base: 400, w: 32, h: 24 },
  { base: 560, w: 46, h: 30 },
];

function startDemoScene() {
  if (demoRafId != null) return;
  demoLastTs = null;
  const loop = (ts) => {
    const dt = demoLastTs == null ? 0 : Math.min((ts - demoLastTs) / 1000, 0.1);
    demoLastTs = ts;
    demoClock += dt;
    updateDemoEntities(dt);
    drawDemoScene();
    demoRafId = requestAnimationFrame(loop);
  };
  demoRafId = requestAnimationFrame(loop);
}

function stopDemoScene() {
  if (demoRafId != null) cancelAnimationFrame(demoRafId);
  demoRafId = null;
}

function updateDemoEntities(dt) {
  demoWorkers.forEach(w => {
    w.x += w.dir * w.speed * dt;
    w.phase += (w.speed / 26) * dt * 2.4;
    if (w.x > w.max) { w.x = w.max; w.dir = -1; }
    if (w.x < w.min) { w.x = w.min; w.dir = 1; }
  });
}

function rr(c, x, y, w, h, r) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

function drawDemoScene() {
  const c = sceneCtx;

  // ── back wall + floor ──
  c.fillStyle = '#EDEBE8';
  c.fillRect(0, 0, DEMO_W, 420);
  c.fillStyle = '#DAD7D4';
  c.fillRect(0, 420, DEMO_W, DEMO_H - 420);
  c.strokeStyle = '#C7C3BF';
  c.lineWidth = 3;
  c.beginPath(); c.moveTo(0, 420); c.lineTo(DEMO_W, 420); c.stroke();

  // floor perspective lines
  c.strokeStyle = 'rgba(176,172,168,0.5)';
  c.lineWidth = 2;
  for (let i = -4; i <= 4; i++) {
    c.beginPath();
    c.moveTo(640 + i * 60, 420);
    c.lineTo(640 + i * 260, DEMO_H);
    c.stroke();
  }

  // safety lane stripes on the floor
  c.strokeStyle = 'rgba(234,179,8,0.55)';
  c.lineWidth = 5;
  c.setLineDash([26, 20]);
  [560, 700].forEach(y => {
    c.beginPath(); c.moveTo(40, y); c.lineTo(DEMO_W - 40, y); c.stroke();
  });
  c.setLineDash([]);

  // ── ceiling lights ──
  [230, 640, 1050].forEach(x => {
    c.strokeStyle = '#B8B4B0'; c.lineWidth = 4;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 34); c.stroke();
    c.fillStyle = '#FFF7DB';
    rr(c, x - 46, 34, 92, 14, 6); c.fill();
    c.strokeStyle = '#D8D4D0'; c.lineWidth = 2;
    rr(c, x - 46, 34, 92, 14, 6); c.stroke();
  });

  // ── windows ──
  for (let i = 0; i < 4; i++) {
    const x = 90 + i * 150;
    c.fillStyle = '#DCE6EC';
    rr(c, x, 70, 108, 78, 6); c.fill();
    c.strokeStyle = '#FFFFFF'; c.lineWidth = 6;
    rr(c, x, 70, 108, 78, 6); c.stroke();
    c.strokeStyle = '#FFFFFF'; c.lineWidth = 4;
    c.beginPath(); c.moveTo(x + 54, 72); c.lineTo(x + 54, 146); c.stroke();
  }

  // ── roller shutter door ──
  c.fillStyle = '#D2CECA';
  c.fillRect(956, 150, 274, 270);
  c.strokeStyle = '#B5B1AD'; c.lineWidth = 3;
  for (let y = 158; y < 418; y += 22) {
    c.beginPath(); c.moveTo(960, y); c.lineTo(1226, y); c.stroke();
  }
  c.fillStyle = '#A8A4A0';
  c.fillRect(948, 140, 10, 280);
  c.fillRect(1230, 140, 10, 280);

  // ── storage racks with boxes ──
  drawDemoRack(c, 80, 250);
  drawDemoRack(c, 380, 250);

  // ── painted floor zone (ties into the zone feature) ──
  c.fillStyle = 'rgba(225,29,72,0.16)';
  c.beginPath();
  c.moveTo(770, 486); c.lineTo(1080, 486); c.lineTo(1140, 660); c.lineTo(716, 660);
  c.closePath(); c.fill();
  c.strokeStyle = 'rgba(225,29,72,0.75)';
  c.lineWidth = 3;
  c.setLineDash([14, 10]);
  c.stroke();
  c.setLineDash([]);
  c.fillStyle = 'rgba(190,18,60,0.85)';
  c.font = '700 20px -apple-system, system-ui, sans-serif';
  c.textAlign = 'center';
  c.fillText('LOADING ZONE', 928, 585);

  // ── conveyor belt with moving boxes ──
  drawDemoConveyor(c);

  // ── forklift ──
  const fx = 640 + 350 * Math.sin(demoClock * 0.32);
  const fdir = Math.cos(demoClock * 0.32) >= 0 ? 1 : -1;
  drawDemoForklift(c, fx, 662, fdir);

  // ── workers ──
  demoWorkers.forEach(w => drawDemoWorker(c, w));
}

function drawDemoRack(c, x, w) {
  const yTop = 168, yBot = 415;
  // uprights
  c.fillStyle = '#8A8580';
  c.fillRect(x, yTop, 10, yBot - yTop);
  c.fillRect(x + w - 10, yTop, 10, yBot - yTop);
  // shelves
  const shelfColors = ['#C89F6D', '#B98A55', '#D4AC76'];
  [248, 332, 414].forEach((sy, i) => {
    c.fillStyle = '#8A8580';
    c.fillRect(x, sy, w, 8);
    // boxes on the shelf
    let bx = x + 16;
    const widths = [64, 84, 56, 74];
    widths.forEach((bw, j) => {
      if (bx + bw > x + w - 14) return;
      c.fillStyle = shelfColors[(i + j) % 3];
      const bh = 44 + ((i + j) % 3) * 10;
      rr(c, bx, sy - bh, bw, bh, 3); c.fill();
      c.strokeStyle = 'rgba(112,82,45,0.4)'; c.lineWidth = 2;
      rr(c, bx, sy - bh, bw, bh, 3); c.stroke();
      bx += bw + 12;
    });
  });
}

function drawDemoConveyor(c) {
  const x0 = 70, x1 = 880, y = 468, h = 58;
  // legs
  c.fillStyle = '#6B7280';
  c.fillRect(x0 + 30, y + h, 10, 62);
  c.fillRect(x1 - 40, y + h, 10, 62);
  // frame
  c.fillStyle = '#4B4B4B';
  rr(c, x0, y, x1 - x0, h, 12); c.fill();
  // belt surface
  c.fillStyle = '#78716C';
  rr(c, x0 + 8, y + 8, x1 - x0 - 16, h - 22, 8); c.fill();
  // moving belt texture
  c.strokeStyle = 'rgba(255,255,255,0.18)';
  c.lineWidth = 3;
  const beltLen = x1 - x0 - 16;
  const off = (demoClock * 70) % 34;
  for (let lx = x0 + 8 + off; lx < x1 - 8; lx += 34) {
    c.beginPath(); c.moveTo(lx, y + 12); c.lineTo(lx, y + h - 18); c.stroke();
  }
  // rollers under the belt
  c.fillStyle = '#A8A29E';
  for (let rx = x0 + 18; rx < x1 - 10; rx += 46) {
    c.beginPath(); c.arc(rx, y + h - 8, 5, 0, Math.PI * 2); c.fill();
  }
  // boxes riding the belt
  demoBoxes.forEach(b => {
    const bx = x0 + 10 + ((b.base + demoClock * 60) % (beltLen - b.w));
    const by = y - b.h + 8;
    c.fillStyle = '#C89F6D';
    rr(c, bx, by, b.w, b.h, 3); c.fill();
    c.strokeStyle = 'rgba(112,82,45,0.45)'; c.lineWidth = 2;
    rr(c, bx, by, b.w, b.h, 3); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(bx + b.w / 2, by + 2); c.lineTo(bx + b.w / 2, by + b.h - 2); c.stroke();
  });
}

function drawDemoWorker(c, w) {
  const s = w.scale;
  const bob = Math.sin(w.phase * 2) * 1.6;
  c.save();
  c.translate(w.x, w.y + bob);

  // shadow
  c.fillStyle = 'rgba(28,25,23,0.15)';
  c.beginPath(); c.ellipse(0, 2, 17 * s, 4.5 * s, 0, 0, Math.PI * 2); c.fill();

  // legs — walk swing
  const swing = Math.sin(w.phase) * 9 * s;
  c.strokeStyle = '#3F3A36';
  c.lineWidth = 5.5 * s;
  c.lineCap = 'round';
  c.beginPath(); c.moveTo(0, -36 * s); c.lineTo( swing, -2 * s); c.stroke();
  c.beginPath(); c.moveTo(0, -36 * s); c.lineTo(-swing, -2 * s); c.stroke();

  // torso — hi-vis vest
  c.fillStyle = w.vest;
  rr(c, -10 * s, -66 * s, 20 * s, 32 * s, 7 * s); c.fill();
  // reflective stripe
  c.fillStyle = 'rgba(255,255,255,0.8)';
  c.fillRect(-10 * s, -52 * s, 20 * s, 3.5 * s);

  // arms
  const armSwing = Math.sin(w.phase + Math.PI) * 6 * s;
  c.strokeStyle = w.vest;
  c.lineWidth = 4.5 * s;
  c.beginPath(); c.moveTo(-8 * s, -60 * s); c.lineTo(-13 * s - armSwing * 0.4, -42 * s); c.stroke();
  c.beginPath(); c.moveTo( 8 * s, -60 * s); c.lineTo( 13 * s + armSwing * 0.4, -42 * s); c.stroke();

  // head
  c.fillStyle = '#D9BFA5';
  c.beginPath(); c.arc(0, -74 * s, 8 * s, 0, Math.PI * 2); c.fill();

  // hard hat (one worker "forgot" theirs — a nod to the PPE rules)
  if (w.helmet) {
    c.fillStyle = '#FBBF24';
    c.beginPath(); c.arc(0, -75 * s, 8.5 * s, Math.PI, 0); c.fill();
    c.fillRect(-8.5 * s, -75 * s, 17 * s, 3 * s);
  } else {
    c.fillStyle = '#4B4B4B';
    c.beginPath(); c.arc(0, -78 * s, 8 * s, Math.PI, 0); c.fill();
  }

  c.restore();
}

function drawDemoForklift(c, x, y, dir) {
  c.save();
  c.translate(x, y);
  if (dir < 0) c.scale(-1, 1);

  // shadow
  c.fillStyle = 'rgba(28,25,23,0.16)';
  c.beginPath(); c.ellipse(0, 0, 74, 9, 0, 0, Math.PI * 2); c.fill();

  // wheels
  c.fillStyle = '#26221F';
  c.beginPath(); c.arc(-36, -12, 13, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.arc( 30, -12, 15, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#6B7280';
  c.beginPath(); c.arc(-36, -12, 5, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.arc( 30, -12, 6, 0, Math.PI * 2); c.fill();

  // body
  c.fillStyle = '#EA580C';
  rr(c, -54, -62, 90, 44, 9); c.fill();
  // cabin window
  c.fillStyle = '#BAE6FD';
  rr(c, -22, -58, 36, 22, 4); c.fill();
  c.strokeStyle = '#9CA3AF'; c.lineWidth = 2;
  rr(c, -22, -58, 36, 22, 4); c.stroke();

  // overhead guard
  c.strokeStyle = '#4B4B4B';
  c.lineWidth = 6;
  c.beginPath(); c.moveTo(-40, -62); c.lineTo(-34, -104); c.lineTo(18, -104); c.lineTo(24, -62); c.stroke();
  c.beginPath(); c.moveTo(-34, -104); c.lineTo(50, -104); c.stroke();

  // mast
  c.fillStyle = '#9CA3AF';
  c.fillRect(46, -92, 9, 92);
  c.fillStyle = '#6B7280';
  c.fillRect(46, -20, 36, 6);  // fork blade
  c.fillRect(46, -30, 6, 12);

  // pallet + load
  const lift = Math.sin(demoClock * 0.7) * 6;
  c.fillStyle = '#B98A55';
  c.fillRect(50, -40 - lift, 40, 7);
  c.fillStyle = '#C89F6D';
  rr(c, 53, -72 - lift, 34, 32, 3); c.fill();
  c.strokeStyle = 'rgba(112,82,45,0.45)'; c.lineWidth = 2;
  rr(c, 53, -72 - lift, 34, 32, 3); c.stroke();

  c.restore();
}

// ═════════════════════════════════════════════════════════════════════════════
// FEED MODE — Live (MJPEG <img>) / Demo (sample.mp4 by default, or an
// uploaded clip once one is loaded; animated canvas scene as a fallback)
// ═════════════════════════════════════════════════════════════════════════════

function attachSceneStream() {
  demoVideo.removeAttribute('src');
  try {
    demoVideo.srcObject = sceneCanvas.captureStream(30);
  } catch (e) {
    console.warn('Demo stream unavailable:', e);
  }
}

// Points #demoVideo at whatever the demo feed should show: the uploaded clip
// when one is active, otherwise the animated canvas scene.
function attachDemoMedia() {
  if (customDemoUrl) {
    demoVideo.srcObject = null;
    if (demoVideo.getAttribute('src') !== customDemoUrl) demoVideo.src = customDemoUrl;
    demoVideo.loop = true;
    stopDemoScene();
  } else {
    attachSceneStream();
    startDemoScene();
  }
  demoVideo.play().catch(() => {});
}

function updateFeedTag() {
  const isDemo = feedMode === 'demo';
  feedTagEl.classList.toggle('demo', isDemo);
  feedTagTextEl.textContent = isDemo ? 'DEMO' : 'LIVE';
}

function setFeedMode(mode, opts = {}) {
  if (mode === feedMode) return;
  if (phase !== 'idle') cancelDraw();
  feedMode = mode;

  document.querySelectorAll('#feedModeToggle .mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });

  const isDemo = mode === 'demo';

  if (isDemo) {
    // ── live → demo ───────────────────────────────────────────────────
    feedImg.hidden = true;                 // live feed hidden (no transition needed)
    // keep demo visible via display override so the fade-in can render
    demoVideo.style.display = 'block !important';
    demoVideo.hidden = false;
    demoVideo.style.opacity = '0';
    attachDemoMedia();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      demoVideo.style.opacity = '';
      // fade done — switch to the normal hidden-attribute mechanism
      demoVideo.style.display = '';
    }));
    hideCameraOverlay();
    updateFeedTag();
    updateUploadControls();
    if (!opts.silent) setBackendDemoMode(true);
  } else {
    // ── demo → live ───────────────────────────────────────────────────
    // keep demo visible via display override so the fade-out can render
    demoVideo.style.display = 'block !important';
    demoVideo.style.opacity = '0';
    stopDemoScene();
    setTimeout(() => {
      demoVideo.pause();
      demoVideo.removeAttribute('src');
      demoVideo.srcObject = null;
      demoVideo.style.display = '';
      demoVideo.style.opacity = '';
      demoVideo.hidden = true;
    }, 320);
    // restore the MJPEG source and fade the live image in
    if (feedImg.dataset.liveSrc) {
      feedImg.src = feedImg.dataset.liveSrc;
      delete feedImg.dataset.liveSrc;
    }
    feedImg.hidden = false;
    feedImg.style.opacity = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      feedImg.style.opacity = '';
    }));
    hideCameraOverlay();
    updateFeedTag();
    updateUploadControls();
    if (feedImg.complete && feedImg.naturalWidth === 0) showCameraOverlay();
    if (!opts.silent) setBackendDemoMode(false);
  }

  updateStartDisabled();
}

document.querySelectorAll('#feedModeToggle .mode-btn').forEach(btn => {
  btn.addEventListener('click', () => setFeedMode(btn.dataset.mode));
});

// The backend switches its analysis frame source with demo mode. While the UI
// plays the procedural scene, the detector reads the loaded sample video —
// load it silently so Start monitoring has frames to analyze.
function setBackendDemoMode(demo) {
  fetchJson('/demo_mode', { method: 'POST', body: { demo_mode: demo } })
    .then(() => {
      if (demo) ensureDemoSource();
    })
    .catch(() => {
      if (demo) toast('Could not reach the server — demo analysis may be unavailable');
    });
}

function ensureDemoSource() {
  fetchJson('/demo_mode')
    .then(d => {
      if (d.video_path) {
        demoSourceReady = true;
        // a previously uploaded clip (e.g. still set after a reload) overrides
        // the animated scene — display it instead
        const path = String(d.video_path).replace(/\\/g, '/');
        if (path.startsWith('uploads/') && feedMode === 'demo' && !customDemoIsBlob) {
          applyCustomDemoVideo('/' + path, false);
        }
        return;
      }
      return fetchJson('/demo_run/load_sample', { method: 'POST' }).then(sd => {
        demoSourceReady = !!sd.ok;
      });
    })
    .catch(() => { demoSourceReady = false; });
}

// ── demo clip upload — swap the animated scene for the user's own video ─────
uploadVideoBtn.addEventListener('click', () => videoFileInput.click());

videoFileInput.addEventListener('change', () => {
  const file = videoFileInput.files && videoFileInput.files[0];
  videoFileInput.value = '';              // allow re-picking the same file
  if (!file) return;
  if (monitoringActive) { toast('Stop monitoring before switching videos'); return; }
  if (!/\.(mp4|mov|avi)$/i.test(file.name)) {
    toast('Unsupported file type — use mp4, mov or avi');
    return;
  }

  uploadVideoBtn.classList.add('loading');
  const body = new FormData();
  body.append('video', file);

  fetch('/upload_video', { method: 'POST', body })
    .then(r => r.json().then(d => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok || !d.ok) throw new Error(d.error || 'Upload failed');
      demoSourceReady = true;
      applyCustomDemoVideo(URL.createObjectURL(file), true);
      toast('Video loaded — start monitoring to analyze your clip');
    })
    .catch(err => toast(err.message || 'Upload failed'))
    .finally(() => uploadVideoBtn.classList.remove('loading'));
});

sampleSceneBtn.addEventListener('click', () => {
  if (monitoringActive) { toast('Stop monitoring before switching videos'); return; }
  restoreAnimatedScene();
});

useSampleBtn.addEventListener('click', () => {
  if (monitoringActive) { toast('Stop monitoring before switching videos'); return; }
  loadSampleVideo();
});

function applyCustomDemoVideo(url, isBlob) {
  if (customDemoIsBlob && customDemoUrl) URL.revokeObjectURL(customDemoUrl);
  customDemoUrl = url;
  customDemoIsBlob = !!isBlob;
  stopDemoScene();
  demoVideo.srcObject = null;
  demoVideo.src = url;
  demoVideo.loop = true;
  if (feedMode === 'demo') demoVideo.play().catch(() => {});
  updateUploadControls();
}

// Load the bundled manufacturing video (demo/sample.mp4) as the demo source.
function loadSampleVideo() {
  stopDemoScene();
  demoVideo.srcObject = null;
  demoVideo.src = 'demo/sample.mp4';
  demoVideo.loop = true;
  customDemoUrl = 'demo/sample.mp4';
  customDemoIsBlob = false;
  demoVideo.play().catch(() => {});
  // point the backend's analysis source at the bundled sample clip
  fetchJson('/demo_run/load_sample', { method: 'POST' })
    .then(() => { demoSourceReady = true; })
    .catch(() => { demoSourceReady = false; });
  updateUploadControls();
}

// Return to the animated canvas scene (the default demo source).
function restoreAnimatedScene() {
  if (customDemoIsBlob && customDemoUrl) URL.revokeObjectURL(customDemoUrl);
  customDemoUrl = null;
  customDemoIsBlob = false;
  attachSceneStream();
  startDemoScene();
  demoVideo.play().catch(() => {});
  // point the backend's analysis source back at the bundled sample clip
  fetchJson('/demo_run/load_sample', { method: 'POST' })
    .then(() => { demoSourceReady = true; })
    .catch(() => { demoSourceReady = false; });
  updateUploadControls();
}

// Upload controls live in the demo feed only, and lock while monitoring.
function updateUploadControls() {
  const demo = feedMode === 'demo';
  uploadVideoBtn.hidden = !demo;
  uploadVideoBtn.disabled = monitoringActive;
  uploadVideoBtn.title = monitoringActive
    ? 'Stop monitoring before switching videos'
    : 'Use your own video clip as the demo feed';
  useSampleBtn.hidden = !(demo && !customDemoUrl);
  useSampleBtn.disabled = monitoringActive;
  sampleSceneBtn.hidden = !(demo && customDemoUrl);
  sampleSceneBtn.disabled = monitoringActive;
}

// ── camera overlay (live feed failure) ────────────────────────────────────────
function showCameraOverlay() {
  if (feedMode === 'live') cameraOverlayEl.classList.add('visible');
}
function hideCameraOverlay() {
  cameraOverlayEl.classList.remove('visible');
}

feedImg.addEventListener('error', () => {
  // ignore the synthetic error fired while the src is blanked for freeze-frame
  if (!feedImg.dataset.liveSrc && feedMode === 'live') showCameraOverlay();
});
feedImg.addEventListener('load', hideCameraOverlay);

// a failed camera keeps the MJPEG stream open with zero bytes — the img never
// fires an error event, so poll until the first real frame arrives
setTimeout(() => {
  const t = setInterval(() => {
    if (feedMode !== 'live' || feedImg.dataset.liveSrc) return;
    if (feedImg.naturalWidth > 0) { hideCameraOverlay(); clearInterval(t); return; }
    showCameraOverlay();
  }, 2000);
}, 5000);

// ── feed freeze / resume (works for live img and demo video) ─────────────────
// The snapshot must live in its own layer — redraw() clears #zoneCanvas on
// every mousemove while a zone is being drawn or moved.
function freezeFeed() {
  const r = canvas.getBoundingClientRect();
  canvas.width = r.width;
  canvas.height = r.height;

  const media = feedMode === 'demo' ? demoVideo : feedImg;
  if (feedMode === 'demo') stopDemoScene();

  let captured = false;
  try {
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    tmp.getContext('2d').drawImage(media, 0, 0, tmp.width, tmp.height);
    frozenFrameEl.src = tmp.toDataURL('image/jpeg', 0.9);
    captured = true;
  } catch (_) {
    captured = false;
  }

  if (!captured) {
    // couldn't capture from the media element — fall back to the backend's
    // last-known frame instead of showing a black screen
    frozenFrameEl.src = `/current_frame?ts=${Date.now()}`;
  }
  frozenFrameEl.hidden = false;

  if (feedMode === 'live') {
    feedImg.dataset.liveSrc = feedImg.src;
    feedImg.src = '';
  } else {
    demoVideo.pause();
  }
  frameEl.classList.add('freeze');
}

function resumeFeed() {
  frameEl.classList.remove('freeze');
  frozenFrameEl.hidden = true;
  frozenFrameEl.src = '';
  if (feedMode === 'demo') {
    if (customDemoUrl) {
      demoVideo.play().catch(() => {});
    } else {
      startDemoScene();
      demoVideo.play().catch(() => {});
    }
  } else if (feedImg.dataset.liveSrc) {
    feedImg.src = feedImg.dataset.liveSrc;
    delete feedImg.dataset.liveSrc;
  }
  syncCanvasSize();
}

// ── canvas sizing ─────────────────────────────────────────────────────────────
function syncCanvasSize() {
  const r = canvas.getBoundingClientRect();
  if (r.width === 0) return;
  canvas.width = r.width;
  canvas.height = r.height;
  redraw();
}
new ResizeObserver(syncCanvasSize).observe(canvas);

// ═════════════════════════════════════════════════════════════════════════════
// ZONE DRAWING
// ═════════════════════════════════════════════════════════════════════════════

const DRAW_HINTS = {
  rect:   'Click and drag to draw a rectangle zone',
  poly:   'Click to place vertices · Double-click or click first point to close',
  circle: 'Click the centre, drag to set radius',
};

function toggleDrawMode() {
  if (phase !== 'idle') { cancelDraw(); return; }
  enterDraw();
}

function enterDraw() {
  phase = 'draw';
  rectStart = rectCur = null;
  polyPts = []; mousePos = null;
  pendingPoly = null; pendingShapeType = null;
  circleCenter = circleEdge = null;
  moveActive = false; moveLast = null;
  resizeMode = null; resizeCornerIndex = -1; resizeAnchor = null; resizeCenterPx = null;
  promptEl.classList.remove('visible');
  document.getElementById('drawToolbar').hidden = false;

  drawMode = (document.querySelector('input[name="drawMode"]:checked') || {}).value || 'rect';

  freezeFeed();

  drawBtn.classList.add('btn-draw-active');
  drawBtn.hidden = true;
  canvas.classList.add('drawing');

  setHint(DRAW_HINTS[drawMode] || '');
  redraw();
}

function enterMove() {
  phase = 'move';
  moveActive = false;
  moveLast = null;
  canvas.classList.remove('drawing');
  canvas.classList.add('moving');
  setHint(moveHintText());
  redraw();
}

function moveHintText() {
  const resizeHint = pendingShapeType === 'rect' ? ' · drag a corner to resize'
                    : pendingShapeType === 'circle' ? ' · drag the edge handle to resize'
                    : '';
  return `Drag to reposition${resizeHint}, then name it below`;
}

function cancelDraw() {
  phase = 'idle';
  rectStart = rectCur = null;
  polyPts = []; mousePos = null;
  pendingPoly = null; pendingShapeType = null;
  circleCenter = circleEdge = null;
  moveActive = false; moveLast = null;
  resizeMode = null; resizeCornerIndex = -1; resizeAnchor = null; resizeCenterPx = null;

  drawBtn.classList.remove('btn-draw-active');
  drawBtn.hidden = false;
  canvas.classList.remove('drawing', 'moving', 'grabbing');
  document.getElementById('drawToolbar').hidden = true;
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

document.getElementById('cancelDrawBtn').addEventListener('click', cancelDraw);

// ── canvas mouse handlers ─────────────────────────────────────────────────────
canvas.addEventListener('mousedown', (e) => {
  if (phase === 'idle') return;
  const p = evPt(e);

  if (phase === 'draw') {
    if (drawMode === 'rect')   { rectStart = p; rectCur = p; }
    if (drawMode === 'circle') { circleCenter = p; circleEdge = p; }
  }

  if (phase === 'move' || phase === 'name') {
    const cornerIdx = hitRectHandle(p);
    if (cornerIdx !== -1) {
      resizeMode = 'rect-corner';
      resizeCornerIndex = cornerIdx;
      const anchorIdx = (cornerIdx + 2) % 4;
      resizeAnchor = { x: pendingPoly[anchorIdx][0], y: pendingPoly[anchorIdx][1] };
      canvas.classList.add('grabbing');
    } else if (hitCircleHandle(p)) {
      resizeMode = 'circle-edge';
      const pts = pendingPoly.map(([nx, ny]) => ({ x: nx * canvas.width, y: ny * canvas.height }));
      const cx = pts.reduce((s, q) => s + q.x, 0) / pts.length;
      const cy = pts.reduce((s, q) => s + q.y, 0) / pts.length;
      resizeCenterPx = { x: cx, y: cy };
      canvas.classList.add('grabbing');
    } else if (pointInPendingPoly(p)) {
      moveActive = true;
      moveLast = p;
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

  if ((phase === 'move' || phase === 'name') && resizeMode === 'rect-corner' && pendingPoly) {
    const mx = p.x / canvas.width, my = p.y / canvas.height;
    const ax = resizeAnchor.x, ay = resizeAnchor.y;
    if (Math.abs(mx - ax) > 0.01 && Math.abs(my - ay) > 0.01) {
      const x1 = Math.min(ax, mx), x2 = Math.max(ax, mx);
      const y1 = Math.min(ay, my), y2 = Math.max(ay, my);
      pendingPoly = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    }
  } else if ((phase === 'move' || phase === 'name') && resizeMode === 'circle-edge' && pendingPoly) {
    const r = Math.max(Math.hypot(p.x - resizeCenterPx.x, p.y - resizeCenterPx.y), 8);
    pendingPoly = Array.from({ length: CIRCLE_SEGS }, (_, i) => {
      const a = (i / CIRCLE_SEGS) * Math.PI * 2;
      return [
        (resizeCenterPx.x + Math.cos(a) * r) / canvas.width,
        (resizeCenterPx.y + Math.sin(a) * r) / canvas.height,
      ];
    });
  } else if ((phase === 'move' || phase === 'name') && moveActive && pendingPoly) {
    const dx = (p.x - moveLast.x) / canvas.width;
    const dy = (p.y - moveLast.y) / canvas.height;
    pendingPoly = pendingPoly.map(([nx, ny]) => [nx + dx, ny + dy]);
    moveLast = p;
  }

  if (phase === 'move' || phase === 'name') {
    if (resizeMode) {
      canvas.style.cursor = 'grabbing';
    } else if (hitRectHandle(p) !== -1 || hitCircleHandle(p)) {
      canvas.style.cursor = 'pointer';
    } else {
      canvas.style.cursor = pointInPendingPoly(p) ? (moveActive ? 'grabbing' : 'grab') : 'default';
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
      if (Math.sqrt(dx * dx + dy * dy) < 8) { circleCenter = circleEdge = null; redraw(); return; }
      finishCircle();
    }
  }

  if ((phase === 'move' || phase === 'name') && (moveActive || resizeMode)) {
    moveActive = false;
    resizeMode = null;
    resizeCornerIndex = -1;
    resizeAnchor = null;
    resizeCenterPx = null;
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
    if (Math.sqrt(dx * dx + dy * dy) <= HANDLE_R * 2.5) { finishPoly(); return; }
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

function hitRectHandle(p) {
  if (pendingShapeType !== 'rect' || !pendingPoly) return -1;
  for (let i = 0; i < pendingPoly.length; i++) {
    const hx = pendingPoly[i][0] * canvas.width;
    const hy = pendingPoly[i][1] * canvas.height;
    if (Math.hypot(p.x - hx, p.y - hy) <= HANDLE_R + 4) return i;
  }
  return -1;
}

function hitCircleHandle(p) {
  if (pendingShapeType !== 'circle' || !pendingPoly) return false;
  const hx = pendingPoly[0][0] * canvas.width;
  const hy = pendingPoly[0][1] * canvas.height;
  return Math.hypot(p.x - hx, p.y - hy) <= HANDLE_R + 4;
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

// ── finish drawing → move phase → naming ──────────────────────────────────────
function finishRect() {
  const x1 = Math.min(rectStart.x, rectCur.x) / canvas.width;
  const y1 = Math.min(rectStart.y, rectCur.y) / canvas.height;
  const x2 = Math.max(rectStart.x, rectCur.x) / canvas.width;
  const y2 = Math.max(rectStart.y, rectCur.y) / canvas.height;
  pendingPoly = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
  pendingShapeType = 'rect';
  rectStart = rectCur = null;
  enterMove();
  showNamePrompt();
}

function finishPoly() {
  pendingPoly = polyPts.map(p => [p.x / canvas.width, p.y / canvas.height]);
  pendingShapeType = 'poly';
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
  pendingShapeType = 'circle';
  circleCenter = circleEdge = null;
  enterMove();
  showNamePrompt();
}

function showNamePrompt() {
  phase = 'name';
  setHint(moveHintText() + ' · save below');
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
  if (savedZones[name]) { toast('A zone with that name already exists'); nameInput.focus(); return; }
  fetchJson('/zones', { method: 'POST', body: { name, points: pendingPoly } })
    .then(d => {
      if (!d.ok) { toast(d.error || 'Failed to save zone'); return; }
      savedZones[name] = pendingPoly;
      pendingPoly = null;
      promptEl.classList.remove('visible');
      renderZoneList();
      syncZoneSelect();
      renderHistoryZoneChips();
      cancelDraw();
    })
    .catch(() => toast('Failed to save zone'));
}

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  confirmZoneName();
  if (e.key === 'Escape') hidePendingPrompt();
});
document.getElementById('saveZoneBtn').addEventListener('click', confirmZoneName);
document.getElementById('cancelZoneBtn').addEventListener('click', hidePendingPrompt);

// ── redraw ────────────────────────────────────────────────────────────────────
function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const [name, pts] of Object.entries(savedZones)) {
    drawZoneShape(pts, ZONE_SAVED_FILL, ZONE_SAVED_STROKE, false, 3);
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
      ctx.fillStyle = ZONE_FILL; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = ZONE_STROKE; ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
    }

    if (drawMode === 'poly' && polyPts.length > 0) {
      ctx.beginPath();
      ctx.moveTo(polyPts[0].x, polyPts[0].y);
      polyPts.forEach(p => ctx.lineTo(p.x, p.y));
      if (mousePos) ctx.lineTo(mousePos.x, mousePos.y);
      ctx.strokeStyle = ZONE_STROKE; ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]); ctx.stroke(); ctx.setLineDash([]);
      polyPts.forEach((p, i) => {
        ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? ZONE_STROKE : '#fff';
        ctx.strokeStyle = ZONE_STROKE; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
      });
      if (polyPts.length >= 3) {
        ctx.beginPath(); ctx.arc(polyPts[0].x, polyPts[0].y, HANDLE_R + 5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(225,29,72,0.4)'; ctx.lineWidth = 2; ctx.stroke();
      }
    }

    if (drawMode === 'circle' && circleCenter) {
      const edge = circleEdge || mousePos || circleCenter;
      const dx = edge.x - circleCenter.x, dy = edge.y - circleCenter.y;
      const r = Math.sqrt(dx * dx + dy * dy);
      ctx.beginPath(); ctx.arc(circleCenter.x, circleCenter.y, Math.max(r, 1), 0, Math.PI * 2);
      ctx.fillStyle = ZONE_FILL; ctx.fill();
      ctx.strokeStyle = ZONE_STROKE; ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]); ctx.stroke(); ctx.setLineDash([]);
      if (r > 8) {
        ctx.beginPath(); ctx.moveTo(circleCenter.x, circleCenter.y); ctx.lineTo(edge.x, edge.y);
        ctx.strokeStyle = 'rgba(225,29,72,0.5)'; ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.beginPath(); ctx.arc(circleCenter.x, circleCenter.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = ZONE_STROKE; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
    }
  }

  if ((phase === 'move' || phase === 'name') && pendingPoly) {
    drawZoneShape(pendingPoly, moveActive ? ZONE_FILL_MOVE : ZONE_FILL, ZONE_STROKE, true);
    const px = pendingPoly.map(p => ({ x: p[0] * canvas.width, y: p[1] * canvas.height }));
    const cx = px.reduce((s, p) => s + p.x, 0) / px.length;
    const cy = px.reduce((s, p) => s + p.y, 0) / px.length;
    drawMoveHandle(cx, cy, moveActive);

    if (pendingShapeType === 'rect') {
      px.forEach((p, i) => drawResizeHandle(p.x, p.y, resizeMode === 'rect-corner' && resizeCornerIndex === i));
    } else if (pendingShapeType === 'circle') {
      drawResizeHandle(px[0].x, px[0].y, resizeMode === 'circle-edge');
    }
  }
}

function drawZoneShape(pts, fill, stroke, dashed, lineWidth) {
  const px = pts.map(p => ({ x: p[0] * canvas.width, y: p[1] * canvas.height }));
  const cx = px.reduce((s, p) => s + p.x, 0) / px.length;
  const cy = px.reduce((s, p) => s + p.y, 0) / px.length;
  const width = lineWidth || (dashed ? 2.5 : 2);

  if (pts.length === CIRCLE_SEGS) {
    const r = px.reduce((s, p) => s + Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2), 0) / px.length;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = width;
    if (dashed) ctx.setLineDash([8, 4]);
    ctx.stroke(); ctx.setLineDash([]);
  } else {
    ctx.beginPath(); ctx.moveTo(px[0].x, px[0].y);
    px.forEach(p => ctx.lineTo(p.x, p.y)); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = width;
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
  ctx.fillStyle   = active ? ZONE_STROKE : 'rgba(255,255,255,0.88)';
  ctx.beginPath(); ctx.roundRect(-s - gap, -s - gap, (s + gap) * 2, (s + gap) * 2, 5); ctx.fill();
  ctx.shadowBlur  = 0;
  ctx.strokeStyle = active ? '#fff' : ACCENT;
  ctx.fillStyle   = active ? '#fff' : ACCENT;
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

function drawResizeHandle(x, y, active) {
  ctx.beginPath(); ctx.arc(x, y, HANDLE_R, 0, Math.PI * 2);
  ctx.fillStyle = active ? ZONE_STROKE : '#fff';
  ctx.strokeStyle = ZONE_STROKE; ctx.lineWidth = 2;
  ctx.fill(); ctx.stroke();
}

function drawLabel(text, cx, cy) {
  ctx.font = '700 13px -apple-system,system-ui,sans-serif';
  const w = ctx.measureText(text).width;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath(); ctx.roundRect(cx - w / 2 - 7, cy - 11, w + 14, 22, 5); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = ZONE_SAVED_STROKE; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(cx - w / 2 - 7, cy - 11, w + 14, 22, 5); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = ZONE_SAVED_STROKE;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);
}

// ═════════════════════════════════════════════════════════════════════════════
// ZONES — chips with rule-count badges + inline delete confirmation
// ═════════════════════════════════════════════════════════════════════════════

function renderZoneList() {
  zonesListEl.innerHTML = '';
  const names = Object.keys(savedZones);

  if (names.length === 0) {
    const empty = el('p', 'empty-state', 'No zones yet — ');
    const link = el('button', 'empty-state-action', 'draw one on the feed');
    link.type = 'button';
    link.addEventListener('click', toggleDrawMode);
    empty.appendChild(link);
    zonesListEl.appendChild(empty);
  }

  names.forEach(name => {
    const count = rules.filter(r => r.zone === name).length;

    const chip = el('div', 'zone-chip');

    chip.appendChild(el('span', 'chip-name', name));

    if (count > 0) {
      const ct = el('span', 'chip-count', String(count));
      ct.title = count === 1 ? '1 rule assigned' : `${count} rules assigned`;
      chip.appendChild(ct);
    }

    const del = el('button', 'chip-del', '×');
    del.type = 'button';
    del.title = 'Delete zone';
    del.addEventListener('click', () => chip.classList.add('confirming'));
    chip.appendChild(del);

    const confirm = el('span', 'chip-confirm');
    confirm.appendChild(el('span', 'chip-confirm-text', 'Delete?'));
    const yes = el('button', 'chip-confirm-yes', 'Delete');
    yes.type = 'button';
    yes.addEventListener('click', () => deleteZone(name));
    const no = el('button', 'chip-confirm-no', 'Cancel');
    no.type = 'button';
    no.addEventListener('click', () => chip.classList.remove('confirming'));
    confirm.appendChild(yes);
    confirm.appendChild(no);
    chip.appendChild(confirm);

    zonesListEl.appendChild(chip);
  });

  zonesSubEl.textContent = names.length === 0
    ? 'Draw a zone on the feed, then attach rules to it'
    : `${names.length} zone${names.length === 1 ? '' : 's'} drawn`;
}

// Zone deletion cascades server-side — rules that referenced the zone come
// back with zone_name: null and zone_name_cleared: true, so reload rules.
function deleteZone(name) {
  fetchJson(`/zones/${encodeURIComponent(name)}`, { method: 'DELETE' })
    .then(d => {
      if (!d.ok) return;
      delete savedZones[name];
      loadRules();
      renderZoneList();
      renderHistoryZoneChips();
      redraw();
    })
    .catch(() => toast('Failed to delete zone'));
}

function loadZones() {
  return fetchJson('/zones')
    .then(d => {
      savedZones = d.zones || {};
      renderZoneList();
      syncZoneSelect();
      renderHistoryZoneChips();
      redraw();
    })
    .catch(() => {});
}

function syncZoneSelect() {
  const prev = zoneSelectEl.value;
  zoneSelectEl.innerHTML = '';
  const whole = el('option', null, 'Whole frame');
  whole.value = '';
  zoneSelectEl.appendChild(whole);
  Object.keys(savedZones).forEach(name => {
    const o = el('option', null, name);
    o.value = name;
    zoneSelectEl.appendChild(o);
  });
  zoneSelectEl.value = prev && savedZones[prev] ? prev : '';
}

// ═════════════════════════════════════════════════════════════════════════════
// RULES — synced with the backend's shared rules store, so the same rules and
// zone assignments drive live monitoring.
// ═════════════════════════════════════════════════════════════════════════════

const RULE_LIBRARY = {
  'People':   ['Person present in the frame', 'Person loitering in view', 'Multiple people gathered',
               'Person lying or collapsed on the floor', 'Person running'],
  'Objects':  ['Object left behind', 'Object missing from view', 'Unattended bag or package'],
  'Safety':   ['Person without a helmet', 'Smoke or fire visible', 'Door left open', 'Spill on the floor'],
  'Vehicles': ['Vehicle present in the driveway', 'Vehicle parked illegally', 'Vehicle reversing'],
};

function loadRules() {
  return fetchJson('/rules')
    .then(d => {
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
    })
    .catch(() => {});
}

function addRule(text, zone) {
  text = (text || '').trim();
  if (!text || monitoringActive) return;
  const zoneName = zone && savedZones[zone] ? zone : null;
  fetchJson('/rules', { method: 'POST', body: { rule_text: text, zone_name: zoneName } })
    .then(d => {
      if (!d.ok) { toast(d.error || 'Failed to add rule'); return; }
      loadRules();
    })
    .catch(() => toast('Failed to add rule'));
}

function renderRules() {
  rulesListEl.innerHTML = '';

  if (rules.length === 0) {
    rulesListEl.appendChild(el('p', 'rules-empty', 'No rules yet — describe one above or pick from the library'));
  }

  rules.forEach(r => {
    const row = el('div', 'rule-row' + (r.enabled ? '' : ' disabled'));

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'rule-check';
    check.checked = r.enabled;
    check.title = r.enabled ? 'Disable rule' : 'Enable rule';
    check.addEventListener('change', () => {
      fetchJson(`/rules/${encodeURIComponent(r.id)}/toggle`, {
        method: 'POST', body: { enabled: check.checked },
      }).then(() => loadRules());
    });
    row.appendChild(check);

    const text = el('span', 'rule-text', r.text);
    text.title = r.text;
    row.appendChild(text);

    if (r.zone) {
      const zb = el('span', 'rule-zone', r.zone);
      zb.title = r.zone;
      row.appendChild(zb);
    } else if (r.zoneCleared) {
      const wb = el('span', 'rule-zone-warning', 'Zone deleted — whole frame');
      wb.title = 'Its assigned zone was deleted; this rule now evaluates the whole frame.';
      row.appendChild(wb);
    } else {
      row.appendChild(el('span', 'rule-zone-whole', 'Whole frame'));
    }

    const del = el('button', 'rule-del', '×');
    del.type = 'button';
    del.title = 'Remove rule';
    del.addEventListener('click', () => {
      fetchJson(`/rules/${encodeURIComponent(r.id)}`, { method: 'DELETE' })
        .then(() => loadRules());
    });
    row.appendChild(del);

    rulesListEl.appendChild(row);
  });

  updateRulesSub();
}

function updateRulesSub() {
  if (monitoringActive) {
    rulesSubEl.textContent = 'Locked while monitoring';
    return;
  }
  const enabled = rules.filter(r => r.enabled).length;
  rulesSubEl.textContent = rules.length === 0
    ? ''
    : `${enabled} of ${rules.length} enabled`;
}

// composer — text input + zone select + Add
addRuleBtnEl.addEventListener('click', () => {
  const text = ruleInputEl.value;
  addRule(text, zoneSelectEl.value);
  ruleInputEl.value = '';
  ruleInputEl.focus();
});

ruleInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addRuleBtnEl.click();
});

// rule library dropdown
function renderRuleLibrary() {
  const lib = document.getElementById('ruleLibrary');
  lib.innerHTML = '';
  Object.entries(RULE_LIBRARY).forEach(([category, items]) => {
    lib.appendChild(el('div', 'library-category', category));
    items.forEach(text => {
      const b = el('button', 'library-item', text);
      b.type = 'button';
      b.addEventListener('click', () => {
        addRule(text, zoneSelectEl.value);
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
// MONITORING — enabled rules are combined into one rule string
// ("rule text in the zone zone") and POSTed to /start.
// ═════════════════════════════════════════════════════════════════════════════

function updateStartDisabled() {
  if (monitoringActive) return;
  const hasRule = rules.filter(r => r.enabled).length > 0;
  startBtn.disabled = !hasRule;
  startBtn.dataset.tip = hasRule
    ? ''
    : 'Add at least one enabled rule to start monitoring';
}

function combinedRuleString() {
  return rules
    .filter(r => r.enabled)
    .map(r => r.zone ? `${r.text} in the zone ${r.zone}` : r.text)
    .join('; ');
}

function startMonitoring() {
  if (rules.filter(r => r.enabled).length === 0) return;
  if (feedMode === 'demo' && !demoSourceReady) {
    toast('No demo video available on the server — cannot monitor');
    return;
  }
  const rule = combinedRuleString();
  fetchJson('/start', { method: 'POST', body: { rule } })
    .then(d => {
      if (!d.ok) { toast(d.error || 'Failed to start monitoring'); return; }
      setMonitoringUI(true);
      pollAlerts();
    })
    .catch(() => toast('Failed to start monitoring'));
}

function stopMonitoring() {
  fetchJson('/stop', { method: 'POST' })
    .then(() => setMonitoringUI(false))
    .catch(() => toast('Failed to stop monitoring'));
}

function setMonitoringUI(active) {
  monitoringActive = active;
  startBtn.hidden = active;
  stopBtn.hidden = !active;
  statusBadgeEl.classList.toggle('active', active);
  statusLabelEl.textContent = active ? 'Monitoring' : 'Idle';
  rulesCardEl.classList.toggle('locked', active);
  updateUploadControls();
  updateRulesSub();
  if (!active) updateStartDisabled();
}

startBtn.addEventListener('click', startMonitoring);
stopBtn.addEventListener('click', stopMonitoring);
drawBtn.addEventListener('click', toggleDrawMode);

// ═════════════════════════════════════════════════════════════════════════════
// ALERTS — poll /alerts/json every 2s; rebuild the list each poll. New alerts
// animate in; previously-seen ones are re-rendered without animation.
// ═════════════════════════════════════════════════════════════════════════════

let currentAlerts = [];
const seenAlertIds = new Set();
let alertPollInterval = null;

function startAlertPolling() {
  if (alertPollInterval) return;
  alertPollInterval = setInterval(pollAlerts, 2000);
  pollAlerts();
}

function pollAlerts() {
  fetchJson('/alerts/json')
    .then(data => {
      setMonitoringUI(!!data.monitoring);
      updateAlerts(data.alerts || []);
    })
    .catch(() => {});
}

function updateAlerts(alerts) {
  const hasNew = alerts.some(a => a.id && !seenAlertIds.has(a.id));
  currentAlerts = alerts;
  renderAlerts();
  if (hasNew) loadDigest();
}

function buildAlertRow(alert) {
  const sev = alert.severity || 'low';
  const row = el('div', `alert-row sev-${sev}`);
  if (alert.id && !seenAlertIds.has(alert.id)) row.classList.add('is-new');

  const img = document.createElement('img');
  img.className = 'alert-thumb';
  img.src = alert.thumbnail;
  img.alt = 'Alert frame';
  img.loading = 'lazy';
  img.addEventListener('click', () => openLightbox(alert));
  row.appendChild(img);

  const body = el('div', 'alert-body');

  const top = el('div', 'alert-top');
  top.appendChild(el('span', 'alert-time', formatTime(alert.timestamp)));
  top.appendChild(el('span', `severity-badge sev-${sev}`, SEVERITY_LABEL[sev] || 'Low'));
  body.appendChild(top);

  body.appendChild(el('p', 'alert-explanation', alert.explanation || ''));

  const metaParts = [
    alert.rule,
    alert.zone,
    confidencePct(alert.confidence),
  ].filter(Boolean);
  body.appendChild(el('p', 'alert-meta', metaParts.join(' · ')));

  row.appendChild(body);
  return row;
}

function renderAlerts() {
  alertsListEl.innerHTML = '';
  alertCountEl.textContent = currentAlerts.length;

  if (currentAlerts.length === 0) {
    alertsListEl.appendChild(el('p', 'empty-state', 'No alerts yet — they will appear here while monitoring'));
    return;
  }

  const frag = document.createDocumentFragment();
  currentAlerts.forEach(alert => frag.appendChild(buildAlertRow(alert)));
  alertsListEl.appendChild(frag);

  // everything rendered is now "seen" — future polls re-render without animating
  currentAlerts.forEach(a => { if (a.id) seenAlertIds.add(a.id); });
}

// ═════════════════════════════════════════════════════════════════════════════
// SHIFT DIGEST — /digest/json for the stats, /digest/ai for the generated text
// ═════════════════════════════════════════════════════════════════════════════

const DIGEST_HOURS = 24;
let digestData = null;

function loadDigest() {
  fetchJson(`/digest/json?hours=${DIGEST_HOURS}`)
    .then(d => {
      digestData = d;
      renderDigest();
    })
    .catch(() => {
      digestSubtitleEl.textContent = 'Stats unavailable';
    });
}

function periodLabel() {
  return `the last ${DIGEST_HOURS} hours`;
}

function renderDigest() {
  if (!digestData) return;
  const total = digestData.total || 0;
  digestSubtitleEl.textContent =
    `${total} incident${total === 1 ? '' : 's'} in ${periodLabel()}`;

  digestStatsEl.innerHTML = '';

  if (total === 0) {
    digestStatsEl.appendChild(el('p', 'digest-empty', `No incidents logged in ${periodLabel()}.`));
    return;
  }

  // By zone — rows clickable through to the history view
  const zoneBlock = el('div');
  zoneBlock.appendChild(el('div', 'digest-stat-title', 'By zone'));
  Object.entries(digestData.by_zone || {}).forEach(([zone, count]) => {
    const row = el('button', 'digest-stat-row');
    row.type = 'button';
    row.title = `View ${zone} incidents in History`;
    row.appendChild(el('span', null, zone));
    row.appendChild(el('span', 'digest-count', String(count)));
    row.addEventListener('click', () => openHistoryFiltered({ zone }));
    zoneBlock.appendChild(row);
  });
  digestStatsEl.appendChild(zoneBlock);

  // By severity — rows clickable through to the history view
  const sevBlock = el('div');
  sevBlock.appendChild(el('div', 'digest-stat-title', 'By severity'));
  ['high', 'medium', 'low'].forEach(sev => {
    const count = (digestData.by_severity || {})[sev] || 0;
    const row = el('button', 'digest-stat-row');
    row.type = 'button';
    row.title = `View ${SEVERITY_LABEL[sev]} incidents in History`;
    const label = el('span', 'digest-severity-label');
    label.appendChild(el('span', `severity-dot severity-dot-${sev}`));
    label.appendChild(document.createTextNode(SEVERITY_LABEL[sev]));
    row.appendChild(label);
    row.appendChild(el('span', 'digest-count', String(count)));
    row.addEventListener('click', () => openHistoryFiltered({ severity: sev }));
    sevBlock.appendChild(row);
  });
  digestStatsEl.appendChild(sevBlock);

  // Busiest hour
  const hourBlock = el('div');
  hourBlock.appendChild(el('div', 'digest-stat-title', 'Busiest hour'));
  const hourRow = el('div', 'digest-stat-row');
  hourRow.appendChild(el('span', null, digestData.busiest_hour || '—'));
  hourBlock.appendChild(hourRow);
  digestStatsEl.appendChild(hourBlock);
}

function openHistoryFiltered({ zone, severity } = {}) {
  historyState.severities.clear();
  historyState.zones.clear();
  if (zone) historyState.zones.add(zone);
  if (severity) historyState.severities.add(severity);
  updateHistoryChips();
  switchView('history');
}

// AI digest generation — spinner on the button, result in the AI digest card
function generateAIDigest() {
  generateDigestBtn.classList.add('loading');

  fetchJson('/digest/ai', { method: 'POST', body: { hours: DIGEST_HOURS } })
    .then(d => {
      generateDigestBtn.classList.remove('loading');
      aiDigestCardEl.hidden = false;

      if (d.stats) {
        digestData = {
          period_hours: DIGEST_HOURS,
          total: d.stats.total,
          by_zone: d.stats.by_zone,
          by_severity: d.stats.by_severity,
          busiest_hour: d.stats.busiest_hour,
        };
        renderDigest();
      }

      aiDigestResultEl.classList.remove('is-error');

      if (d.error) {
        aiDigestSubtitleEl.textContent = 'Generation failed';
        aiDigestResultEl.textContent = d.error;
        aiDigestResultEl.classList.add('is-error');
      } else {
        aiDigestSubtitleEl.textContent = d.summary || '';
        if (d.digest) {
          renderDigestText(d.digest);
        } else {
          aiDigestResultEl.textContent = d.summary || 'No incidents recorded.';
        }
      }

      aiDigestCardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    })
    .catch(() => {
      generateDigestBtn.classList.remove('loading');
      aiDigestCardEl.hidden = false;
      aiDigestSubtitleEl.textContent = 'Generation failed';
      aiDigestResultEl.textContent = 'Failed to generate digest.';
      aiDigestResultEl.classList.add('is-error');
    });
}

// strip markdown bold the model may add, then bold the numbered section
// headers ourselves ("1) Summary", "2) Patterns", …)
function renderDigestText(text) {
  const plain = text.replace(/\*\*/g, '');
  const escaped = escapeHtml(plain);
  const withHeaders = escaped.replace(
    /(^|\n)\s*(\d\)\s*[A-Za-z ]+?)(\s*[—:-])/g,
    (match, pre, header, sep) => `${pre}<strong>${header}</strong>${sep}`
  );
  aiDigestResultEl.innerHTML = withHeaders.replace(/\n/g, '<br>');
}

generateDigestBtn.addEventListener('click', generateAIDigest);

// ═════════════════════════════════════════════════════════════════════════════
// ALERT HISTORY — full-page view: time range + severity chips + zone chips
// ═════════════════════════════════════════════════════════════════════════════

const historyState = {
  hours: 24,
  severities: new Set(),
  zones: new Set(),
};
let historyRecords = [];

function renderHistoryZoneChips() {
  zoneChipsEl.innerHTML = '';
  ['Whole frame', ...Object.keys(savedZones)].forEach(name => {
    const chip = el('button', 'filter-chip', name);
    chip.type = 'button';
    chip.dataset.zone = name;
    chip.classList.toggle('active', historyState.zones.has(name));
    chip.addEventListener('click', () => {
      if (historyState.zones.has(name)) historyState.zones.delete(name);
      else historyState.zones.add(name);
      updateHistoryChips();
      renderHistory();
    });
    zoneChipsEl.appendChild(chip);
  });
}

severityChipsEl.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const sev = chip.dataset.sev;
    if (historyState.severities.has(sev)) historyState.severities.delete(sev);
    else historyState.severities.add(sev);
    updateHistoryChips();
    renderHistory();
  });
});

historyRangeEl.addEventListener('change', () => {
  historyState.hours = parseInt(historyRangeEl.value, 10) || 24;
  loadHistory();
});

function updateHistoryChips() {
  zoneChipsEl.querySelectorAll('.filter-chip').forEach(chip => {
    chip.classList.toggle('active', historyState.zones.has(chip.dataset.zone));
  });
  severityChipsEl.querySelectorAll('.filter-chip').forEach(chip => {
    chip.classList.toggle('active', historyState.severities.has(chip.dataset.sev));
  });
}

function loadHistory() {
  const since = localIsoHoursAgo(historyState.hours);
  fetchJson(`/incidents?since=${encodeURIComponent(since)}`)
    .then(d => {
      historyRecords = d.incidents || [];
      renderHistory();
    })
    .catch(() => toast('Failed to load alert history'));
}

function filteredHistoryRecords() {
  let records = historyRecords.slice().reverse();  // newest first
  if (historyState.severities.size > 0) {
    records = records.filter(r => historyState.severities.has(r.severity || 'low'));
  }
  if (historyState.zones.size > 0) {
    records = records.filter(r => {
      const zone = r.zone_name || 'Whole frame';
      return historyState.zones.has(zone);
    });
  }
  return records;
}

function renderHistory() {
  historyListEl.innerHTML = '';
  const records = filteredHistoryRecords();

  if (historyCountEl) {
    historyCountEl.textContent = `${records.length} incident${records.length === 1 ? '' : 's'}`;
  }

  if (records.length === 0) {
    historyListEl.appendChild(
      el('p', 'empty-state', 'No incidents match the current filters')
    );
    return;
  }

  const frag = document.createDocumentFragment();
  records.forEach(rec => frag.appendChild(buildHistoryItem(rec)));
  historyListEl.appendChild(frag);
}

function buildHistoryItem(rec) {
  const sev = rec.severity || 'low';
  const item = el('div', 'history-item');

  const img = document.createElement('img');
  img.className = 'history-thumb';
  img.src = rec.thumbnail || '';
  img.alt = 'Incident frame';
  img.loading = 'lazy';
  img.addEventListener('click', () => openLightbox({
    thumbnail: rec.thumbnail,
    explanation: rec.explanation,
    rule: rec.rule_text,
    zone: rec.zone_name,
    timestamp: rec.timestamp,
    confidence: rec.confidence,
  }));
  if (!rec.thumbnail) img.style.visibility = 'hidden';
  item.appendChild(img);

  const body = el('div', 'history-body');

  const top = el('div', 'history-top');
  top.appendChild(el('span', 'history-datetime', formatDateTime(rec.timestamp)));
  top.appendChild(el('span', `severity-badge sev-${sev}`, SEVERITY_LABEL[sev] || 'Low'));
  body.appendChild(top);

  body.appendChild(el('p', 'history-explanation', rec.explanation || ''));

  const metaParts = [
    rec.rule_text ? `Rule: ${rec.rule_text}` : '',
    rec.zone_name ? `Zone: ${rec.zone_name}` : 'Zone: whole frame',
    `Confidence: ${confidencePct(rec.confidence)}`,
  ].filter(Boolean);
  body.appendChild(el('p', 'history-meta', metaParts.join(' · ')));

  item.appendChild(body);
  return item;
}

// ═════════════════════════════════════════════════════════════════════════════
// ALERT IMAGE LIGHTBOX
// ═════════════════════════════════════════════════════════════════════════════

function alertMetaText(alert) {
  const parts = [
    alert.rule,
    alert.zone,
    formatTime(alert.timestamp),
    confidencePct(alert.confidence),
  ].filter(Boolean);
  return parts.join(' · ');
}

function openLightbox(alert) {
  lightboxImgEl.src = alert.thumbnail;
  lightboxExplEl.textContent = alert.explanation || '';
  lightboxMetaEl.textContent = alertMetaText(alert);
  lightboxBackdropEl.hidden = false;
}

function closeLightbox() {
  lightboxBackdropEl.hidden = true;
  lightboxImgEl.src = '';
}

lightboxBackdropEl.addEventListener('click', (e) => {
  if (e.target === lightboxBackdropEl) closeLightbox();
});
document.getElementById('lightboxCloseBtn').addEventListener('click', closeLightbox);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightboxBackdropEl.hidden) closeLightbox();
});

// ═════════════════════════════════════════════════════════════════════════════
// INIT
// ═════════════════════════════════════════════════════════════════════════════

renderRuleLibrary();
updateFeedTag();
loadZones()
  .then(() => loadRules())
  .catch(() => {});
loadDigest();
startAlertPolling();

// sync the feed mode with whatever the backend was last left with (e.g. the
// DEMO_MODE env flag) so analysis and the UI agree from the first paint
fetchJson('/demo_mode')
  .then(d => {
    if (d.demo_mode) {
      setFeedMode('demo', { silent: true });
      ensureDemoSource();
    }
  })
  .catch(() => {});
