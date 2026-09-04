/* Openeye landing page — hero + how-it-works canvas animations and interactions */
(function () {
  'use strict';

  // ── Utilities ─────────────────────────────────────────────────────────────
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const rand = (min, max) => Math.random() * (max - min) + min;

  function setupCanvas(canvas, logicalW, logicalH) {
    const ctx = canvas.getContext('2d');
    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(canvas.width / logicalW, 0, 0, canvas.height / logicalH, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);
    return { ctx, logicalW, logicalH };
  }

  // ── Hero canvas: network of camera / zone / alert nodes ───────────────────
  (function initHero() {
    const canvas = document.getElementById('heroCanvas');
    if (!canvas) return;
    const { ctx, logicalW: W, logicalH: H } = setupCanvas(canvas, 1440, 900);

    const nodeCount = 46;
    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
      nodes.push({
        x: rand(0, W),
        y: rand(0, H),
        vx: rand(-0.25, 0.25),
        vy: rand(-0.18, 0.18),
        r: rand(2, 4.5),
        type: Math.random() > 0.75 ? 'zone' : 'cam',
        pulseOffset: rand(0, Math.PI * 2)
      });
    }

    let frame = 0;
    function drawHero(now) {
      frame++;
      ctx.clearRect(0, 0, W, H);

      // Subtle warm gradient fill
      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, 'rgba(250, 250, 249, 0)');
      grad.addColorStop(1, 'rgba(250, 250, 249, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      const time = now * 0.001;

      // Update nodes
      nodes.forEach(n => {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < -20) n.x = W + 20;
        if (n.x > W + 20) n.x = -20;
        if (n.y < -20) n.y = H + 20;
        if (n.y > H + 20) n.y = -20;
      });

      // Draw connections
      ctx.lineWidth = 0.8;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 180) {
            const alpha = (1 - d / 180) * 0.14;
            ctx.strokeStyle = `rgba(120, 113, 108, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Draw nodes
      nodes.forEach(n => {
        const pulse = Math.sin(time * 1.5 + n.pulseOffset) * 0.5 + 0.5;
        if (n.type === 'zone') {
          // Zone node: rose ring
          ctx.strokeStyle = `rgba(225, 29, 72, ${0.2 + pulse * 0.25})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r + 4 + pulse * 3, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = 'rgba(225, 29, 72, 0.9)';
        } else {
          // Camera node: dark dot
          ctx.fillStyle = 'rgba(68, 64, 60, 0.75)';
        }
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      });

      // Occasional alert pulse traveling along a connection
      const alertIndex = Math.floor((time * 0.3) % nodes.length);
      const alertNode = nodes[alertIndex];
      const nearby = nodes
        .map((n, i) => ({ n, i, d: Math.hypot(n.x - alertNode.x, n.y - alertNode.y) }))
        .filter(o => o.d > 40 && o.d < 160)
        .sort((a, b) => a.d - b.d)[0];

      if (nearby && frame % 3 === 0) {
        const t = (time * 0.6) % 1;
        const ax = lerp(alertNode.x, nearby.n.x, t);
        const ay = lerp(alertNode.y, nearby.n.y, t);
        ctx.fillStyle = 'rgba(225, 29, 72, 0.9)';
        ctx.beginPath();
        ctx.arc(ax, ay, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ax, ay, 8 + Math.sin(time * 8) * 2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(225, 29, 72, 0.25)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      requestAnimationFrame(drawHero);
    }
    requestAnimationFrame(drawHero);
  })();

  // ── How it works canvas: step visualizer ──────────────────────────────────
  (function initHow() {
    const canvas = document.getElementById('howCanvas');
    if (!canvas) return;
    const { ctx, logicalW: W, logicalH: H } = setupCanvas(canvas, 720, 420);

    let activeStep = 0;
    let stepProgress = 0; // 0-1 transition between steps
    let prevStep = 0;
    let transitionDir = 0;

    const zonePoly = [{ x: 460, y: 160 }, { x: 620, y: 140 }, { x: 640, y: 300 }, { x: 480, y: 330 }];
    const worker = { x: 160, y: 260, targetX: 510, targetY: 230, legPhase: 0 };

    function setStep(idx) {
      if (idx === activeStep) return;
      prevStep = activeStep;
      activeStep = idx;
      transitionDir = 1;
      stepProgress = 0;
    }

    // Expose for tabs
    window.setHowStep = setStep;

    function drawWarehouseScene(opacity) {
      ctx.globalAlpha = opacity;
      ctx.fillStyle = '#1C1A18';
      ctx.fillRect(0, 240, W, 180);
      ctx.fillStyle = '#252321';
      ctx.fillRect(30, 70, 220, 160);
      ctx.fillStyle = '#2E2C29';
      for (let i = 0; i < 4; i++) ctx.fillRect(42 + i * 52, 82, 42, 136);
      ctx.fillStyle = '#3B3834';
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if ((r + c) % 3) ctx.fillRect(48 + c * 52, 94 + r * 40, 28, 22);
      ctx.fillStyle = '#2A2825';
      ctx.fillRect(560, 100, 140, 170);
      ctx.fillStyle = '#363330';
      ctx.fillRect(575, 118, 110, 90);
      ctx.fillStyle = '#E11D48';
      ctx.beginPath();
      ctx.arc(630, 163, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 300);
      ctx.lineTo(W, 300);
      ctx.stroke();
      drawWorkerFigure(120, 280, 0.75, false, 0);
      drawWorkerFigure(240, 130, 0.6, false, 0);
      ctx.globalAlpha = 1;
    }

    function drawWorkerFigure(x, y, scale, moving, legPhase) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      const off = moving ? Math.sin(legPhase) * 5 : 0;
      ctx.strokeStyle = '#9A3412';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-5 + off, 20); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(5 - off, 20); ctx.stroke();
      ctx.fillStyle = '#F97316';
      ctx.fillRect(-7, -18, 14, 18);
      ctx.fillStyle = '#FDBA74';
      ctx.beginPath(); ctx.arc(0, -24, 6, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    function drawZone(opacity, progress = 1, pulse = 0) {
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.fillStyle = `rgba(225, 29, 72, ${0.1 + pulse * 0.1})`;
      ctx.beginPath();
      ctx.moveTo(zonePoly[0].x, zonePoly[0].y);
      for (let i = 1; i < zonePoly.length; i++) ctx.lineTo(zonePoly[i].x, zonePoly[i].y);
      ctx.closePath();
      ctx.fill();

      const total = zonePoly.length;
      const drawn = Math.floor(progress * total);
      const partial = progress * total - drawn;
      const pts = [];
      for (let i = 0; i <= drawn && i < total; i++) pts.push([zonePoly[i].x, zonePoly[i].y]);
      if (drawn < total && drawn >= 0) {
        const a = zonePoly[drawn % total], b = zonePoly[(drawn + 1) % total];
        pts.push([lerp(a.x, b.x, partial), lerp(a.y, b.y, partial)]);
      }
      if (pts.length > 1) {
        ctx.strokeStyle = `rgba(225, 29, 72, ${0.9 + pulse * 0.5})`;
        ctx.lineWidth = 2.5 + pulse * 2;
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
      }
      if (progress >= 0.8) {
        ctx.globalAlpha = opacity * clamp((progress - 0.8) / 0.2, 0, 1);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '600 14px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('DANGER ZONE', 560, 240);
      }
      ctx.restore();
    }

    function drawAlertCard(opacity) {
      ctx.save();
      ctx.globalAlpha = opacity;
      const x = W - 280, y = 130, w = 250, h = 110;
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 6;
      ctx.fillStyle = '#FFFFFF';
      roundRect(x, y, w, h, 8);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = '#E11D48';
      ctx.fillRect(x, y, 5, h);
      ctx.fillStyle = '#1C1917';
      ctx.font = '700 13px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Person in danger zone', x + 18, y + 28);
      ctx.fillStyle = '#57534E';
      ctx.font = '11px Inter, sans-serif';
      ctx.fillText('Worker entered restricted', x + 18, y + 52);
      ctx.fillText('zone near machine', x + 18, y + 68);
      ctx.fillStyle = '#E11D48';
      ctx.font = '700 11px Inter, sans-serif';
      ctx.fillText('97% · DANGER ZONE', x + 18, y + 90);
      ctx.restore();
    }

    function drawTelegram(opacity) {
      ctx.save();
      ctx.globalAlpha = opacity;
      const x = W - 260, y = 20, w = 230, h = 64;
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 5;
      ctx.fillStyle = '#1C1917';
      roundRect(x, y, w, h, 10);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = '#2AABEE';
      ctx.beginPath(); ctx.arc(x + 28, y + 32, 14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.moveTo(x + 22, y + 32); ctx.lineTo(x + 34, y + 26); ctx.lineTo(x + 31, y + 32); ctx.lineTo(x + 34, y + 38); ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '600 11px Inter, sans-serif';
      ctx.fillText('Openeye Alert', x + 52, y + 24);
      ctx.fillStyle = '#A8A29E';
      ctx.font = '11px Inter, sans-serif';
      ctx.fillText('Person in danger zone', x + 52, y + 42);
      ctx.fillStyle = '#2A2825';
      roundRect(x + w - 46, y + 12, 34, 40, 4);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    function drawStep0(t) {
      drawWarehouseScene(1);
      // Camera connection pulse
      const cx = 60, cy = 60, r = 22 + Math.sin(t * 4) * 4;
      ctx.strokeStyle = 'rgba(225, 29, 72, 0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#E11D48';
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '600 12px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('CAM-01 connected', cx + 24, cy + 4);
    }

    function drawStep1(t) {
      drawWarehouseScene(1);
      const progress = (Math.sin(t * 1.2) * 0.5 + 0.5) * 0.9 + 0.1;
      drawZone(1, progress, 0);
    }

    function drawStep2(t) {
      drawWarehouseScene(1);
      drawZone(1, 1, Math.sin(t * 3) * 0.15 + 0.15);
      // Floating rule text
      const y = 60 + Math.sin(t * 2) * 5;
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = '#FFFFFF';
      ctx.shadowColor = 'rgba(0,0,0,0.2)';
      ctx.shadowBlur = 12;
      roundRect(40, y, 260, 46, 8);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = '#1C1917';
      ctx.font = '500 13px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('"Alert if a person enters', 56, y + 20);
      ctx.fillText('the danger zone"', 56, y + 36);
      ctx.restore();
    }

    function drawStep3(t) {
      drawWarehouseScene(1);
      drawZone(1, 1, Math.sin(t * 6) * 0.3 + 0.3);
      const wx = lerp(worker.x, worker.targetX, easeOutCubic((Math.sin(t * 1.5) * 0.5 + 0.5)));
      const wy = lerp(worker.y, worker.targetY, easeOutCubic((Math.sin(t * 1.5) * 0.5 + 0.5)));
      worker.legPhase += 0.3;
      drawWorkerFigure(wx, wy, 1, true, worker.legPhase);
      drawAlertCard(1);
      drawTelegram(1);
    }

    function renderHow(now) {
      const time = now * 0.001;
      ctx.clearRect(0, 0, W, H);

      // Background
      ctx.fillStyle = '#131211';
      ctx.fillRect(0, 0, W, H);

      // Handle step transition
      if (transitionDir === 1) {
        stepProgress += 0.035;
        if (stepProgress >= 1) {
          stepProgress = 1;
          transitionDir = 0;
          prevStep = activeStep;
        }
      }

      const fadeOut = 1 - stepProgress;
      const fadeIn = stepProgress;

      // Draw previous step fading out
      if (fadeOut > 0.01) {
        ctx.save();
        ctx.globalAlpha = fadeOut;
        [drawStep0, drawStep1, drawStep2, drawStep3][prevStep](time);
        ctx.restore();
      }

      // Draw active step fading in
      if (fadeIn > 0.01) {
        ctx.save();
        ctx.globalAlpha = fadeIn;
        [drawStep0, drawStep1, drawStep2, drawStep3][activeStep](time);
        ctx.restore();
      }

      requestAnimationFrame(renderHow);
    }
    requestAnimationFrame(renderHow);
  })();

  // ── Tab switching ─────────────────────────────────────────────────────────
  const tabs = document.querySelectorAll('.how-tab');
  const steps = document.querySelectorAll('.how-step');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const idx = parseInt(tab.dataset.step, 10);
      tabs.forEach(t => t.classList.remove('active'));
      steps.forEach(s => s.classList.remove('active'));
      tab.classList.add('active');
      steps[idx].classList.add('active');
      if (window.setHowStep) window.setHowStep(idx);
    });
  });

  // ── Mobile menu (basic toggle) ────────────────────────────────────────────
  const mobileBtn = document.getElementById('mobileMenuBtn');
  if (mobileBtn) {
    mobileBtn.addEventListener('click', () => {
      const nav = document.querySelector('.main-nav');
      if (nav) nav.classList.toggle('mobile-open');
    });
  }

  // ── Demo video custom play overlay ────────────────────────────────────────
  const demoVideo = document.getElementById('demoVideo');
  const videoPlayBtn = document.getElementById('videoPlayBtn');
  if (demoVideo && videoPlayBtn) {
    videoPlayBtn.addEventListener('click', () => {
      demoVideo.play();
      videoPlayBtn.classList.add('hidden');
    });
    demoVideo.addEventListener('pause', () => videoPlayBtn.classList.remove('hidden'));
    demoVideo.addEventListener('ended', () => videoPlayBtn.classList.remove('hidden'));
    demoVideo.addEventListener('play', () => videoPlayBtn.classList.add('hidden'));
  }

  // ── Header shadow on scroll ───────────────────────────────────────────────
  const header = document.getElementById('header');
  window.addEventListener('scroll', () => {
    if (header) {
      header.classList.toggle('scrolled', window.scrollY > 10);
    }
  });
})();
