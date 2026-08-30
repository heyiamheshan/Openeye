let knownIds = new Set();
let pollInterval = null;

function startMonitoring() {
  const rule = document.getElementById('ruleInput').value.trim();
  if (!rule) {
    document.getElementById('ruleInput').focus();
    return;
  }
  fetch('/rule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rule })
  }).then(() => {
    setMonitoringUI(true);
    startPolling();
  });
}

function stopMonitoring() {
  fetch('/stop', { method: 'POST' }).then(() => {
    setMonitoringUI(false);
  });
}

function setMonitoringUI(active) {
  document.getElementById('startBtn').disabled = active;
  document.getElementById('stopBtn').disabled = !active;
  document.getElementById('ruleInput').readOnly = active;
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  const badge = document.getElementById('statusBadge');
  if (active) {
    dot.className = 'status-dot active';
    label.textContent = 'Monitoring';
    badge.className = 'status-badge status-active';
  } else {
    dot.className = 'status-dot';
    label.textContent = 'Idle';
    badge.className = 'status-badge';
  }
}

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(pollAlerts, 2000);
  pollAlerts();
}

function pollAlerts() {
  fetch('/alerts')
    .then(r => r.json())
    .then(data => {
      // sync UI state if server says stopped
      if (!data.monitoring) {
        setMonitoringUI(false);
        clearInterval(pollInterval);
        pollInterval = null;
      } else {
        setMonitoringUI(true);
      }
      renderAlerts(data.alerts);
    })
    .catch(() => {});
}

function renderAlerts(alerts) {
  const list = document.getElementById('alertsList');
  const empty = document.getElementById('emptyState');
  const countEl = document.getElementById('alertCount');

  countEl.textContent = alerts.length;

  if (alerts.length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  alerts.forEach(alert => {
    if (knownIds.has(alert.id)) return;
    knownIds.add(alert.id);

    const card = document.createElement('div');
    card.className = 'alert-card';
    card.innerHTML = `
      <img class="alert-thumb" src="${alert.thumbnail}" alt="Alert frame" loading="lazy" />
      <div class="alert-body">
        <div class="alert-meta">
          <time class="alert-time">${formatTime(alert.timestamp)}</time>
          <span class="confidence-badge">${Math.round(alert.confidence * 100)}%</span>
        </div>
        <p class="alert-explanation">${escapeHtml(alert.explanation)}</p>
        <p class="alert-rule">${escapeHtml(alert.rule)}</p>
      </div>
    `;
    // insert newest at top, after any existing cards
    const firstCard = list.querySelector('.alert-card');
    if (firstCard) {
      list.insertBefore(card, firstCard);
    } else {
      list.appendChild(card);
    }
  });
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// start polling immediately to sync server state on page load
startPolling();
