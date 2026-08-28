/* ── HOOKPRINT — Bill of Materials — panel.js ── */

// Task 5: Exposed hook for Kevin's real action handler.
window.HOOKPRINT_UI = {
  onAction: (action_id) => { /* Kevin replaces this */ }
};

// ── Mechanism icons ───────────────────────────────────────────────────────────

const MECHANISM_ICONS = {
  infinite_scroll:         '∞',
  autoplay:                '▶',
  variable_interval_refetch:'⟳',
  countdown_timer:         '⏱',
  scarcity_message:        '⚠',
  unknown:                 '?',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Returns { dir, filename } split from a URL path */
function parseFileUrl(fileUrl) {
  try {
    const parts = new URL(fileUrl).pathname.split('/').filter(Boolean);
    const filename = parts.pop() || fileUrl;
    const dir = parts.length ? parts.join(' / ') : '';
    return { dir, filename, full: fileUrl };
  } catch (_) {
    return { dir: '', filename: fileUrl, full: fileUrl };
  }
}

/** Human-readable "X min ago" from an ISO string */
function timeAgo(iso) {
  try {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch (_) { return ''; }
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let _toastEl = null;

function showToast(action_id) {
  if (!_toastEl) return;
  _toastEl.textContent = `● ${action_id}  — intervention applied`;
  _toastEl.classList.add('visible');
}

// ── Copy to clipboard ─────────────────────────────────────────────────────────

function makeCopyBtn(text) {
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.textContent = 'COPY';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'COPIED';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'COPY';
        btn.classList.remove('copied');
      }, 1800);
    });
  });
  return btn;
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

// Maps key index (1-based) → button element
const _kbdButtons = {};

document.addEventListener('keydown', (e) => {
  // Ignore if typing in an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 9 && _kbdButtons[n]) {
    _kbdButtons[n].click();
  }
});

// ── Card builder ──────────────────────────────────────────────────────────────

let _actionIndex = 0; // tracks keyboard shortcut numbers

function buildFindingCard(finding, isHighConfidence) {
  const card = document.createElement('div');
  card.className = `finding-card conf-${finding.confidence}`;
  card.dataset.findingId = finding.id;

  // ── Mechanism header (clickable to collapse) ──────────────────────────────
  const mechRow = document.createElement('div');
  mechRow.className = 'card-row card-mechanism';

  const icon = document.createElement('span');
  icon.className = 'mechanism-icon';
  icon.textContent = MECHANISM_ICONS[finding.mechanism] || '?';

  const nameEl = document.createElement('span');
  nameEl.className = 'mechanism-name';
  nameEl.textContent = finding.display_name;

  const arrow = document.createElement('span');
  arrow.className = 'card-collapse-arrow open';
  arrow.textContent = '▶';

  mechRow.appendChild(icon);
  mechRow.appendChild(nameEl);
  mechRow.appendChild(arrow);

  // Card body — collapsed for low confidence by default
  const body = document.createElement('div');
  body.className = isHighConfidence ? 'card-body' : 'card-body collapsed';
  if (!isHighConfidence) arrow.classList.remove('open');

  mechRow.addEventListener('click', () => {
    const collapsed = body.classList.toggle('collapsed');
    arrow.classList.toggle('open', !collapsed);
  });

  // ── Confidence row ────────────────────────────────────────────────────────
  const confRow = document.createElement('div');
  confRow.className = 'card-row card-confidence';
  const conf = finding.confidence.toLowerCase();
  confRow.innerHTML = `
    <div class="row-label">Confidence</div>
    <span class="confidence-badge ${escapeHtml(conf)}">${escapeHtml(finding.confidence)}</span>
  `;

  // ── Evidence row ──────────────────────────────────────────────────────────
  const ev = finding.evidence;
  const { dir, filename, full } = parseFileUrl(ev.file);

  const evidRow = document.createElement('div');
  evidRow.className = 'card-row card-evidence';

  const bcHtml = `
    <div class="row-label">Evidence</div>
    <div class="evidence-breadcrumb">
      ${dir ? `<span class="breadcrumb-dir">${escapeHtml(dir)}</span><span class="breadcrumb-sep">/</span>` : ''}
      <span class="breadcrumb-file" title="${escapeHtml(full)}">${escapeHtml(filename)}</span>
      <span class="breadcrumb-sep">:</span>
      <span class="breadcrumb-line">${escapeHtml(String(ev.line))}</span>
      <span class="breadcrumb-sep">:</span>
      <span class="breadcrumb-col">col ${escapeHtml(String(ev.column))}</span>
    </div>
  `;
  evidRow.innerHTML = bcHtml;

  const snippetWrap = document.createElement('div');
  snippetWrap.className = 'snippet-wrap';

  const pre = document.createElement('pre');
  pre.className = 'evidence-snippet';
  pre.textContent = ev.snippet;

  snippetWrap.appendChild(pre);
  snippetWrap.appendChild(makeCopyBtn(ev.snippet));
  evidRow.appendChild(snippetWrap);

  // ── Observed row ──────────────────────────────────────────────────────────
  const obsRow = document.createElement('div');
  obsRow.className = 'card-row card-observed';
  obsRow.innerHTML = `
    <div class="row-label">Observed</div>
    <div class="observed-summary">${escapeHtml(finding.observed.summary)}</div>
  `;

  // ── Action row ────────────────────────────────────────────────────────────
  const actionRow = document.createElement('div');
  actionRow.className = 'card-row card-action';
  actionRow.innerHTML = `<div class="row-label">Action</div>`;

  const actionInner = document.createElement('div');
  actionInner.className = 'action-row-inner';

  if (finding.action.supported) {
    _actionIndex++;
    const kbdNum = _actionIndex; // capture for closure

    const btn = document.createElement('button');
    btn.className = 'action-btn';
    btn.textContent = finding.action.label;
    btn.dataset.actionId = finding.action.action_id;

    // Keyboard shortcut badge
    const kbdHint = document.createElement('span');
    kbdHint.className = 'kbd-hint';
    kbdHint.textContent = `[${kbdNum}]`;

    btn.addEventListener('click', () => {
      const action_id = btn.dataset.actionId;
      console.log('[HOOKPRINT] Action fired:', action_id);
      window.HOOKPRINT_UI.onAction(action_id);

      // Flip to DISABLED ✓
      btn.textContent = 'DISABLED ✓';
      btn.classList.add('disabled-state');
      btn.disabled = true;
      kbdHint.style.opacity = '0.3';

      // Show toast
      showToast(action_id);
    });

    // Register keyboard shortcut
    _kbdButtons[kbdNum] = btn;

    actionInner.appendChild(btn);
    actionInner.appendChild(kbdHint);
  } else {
    const label = document.createElement('span');
    label.className = 'not-supported';
    label.textContent = 'NOT SUPPORTED';
    actionInner.appendChild(label);
  }

  actionRow.appendChild(actionInner);

  // Assemble card body rows
  body.appendChild(confRow);
  body.appendChild(evidRow);
  body.appendChild(obsRow);
  body.appendChild(actionRow);

  card.appendChild(mechRow);
  card.appendChild(body);

  return card;
}

// ── Dropped section ───────────────────────────────────────────────────────────

function buildDroppedSection(dropped) {
  const section = document.createElement('div');
  section.id = 'dropped-section';

  const toggle = document.createElement('button');
  toggle.id = 'dropped-toggle';
  toggle.setAttribute('aria-expanded', 'false');

  const arrow = document.createElement('span');
  arrow.className = 'toggle-arrow';
  arrow.textContent = '▶';

  const label = document.createTextNode(
    ` ${dropped.length} candidate mechanic${dropped.length !== 1 ? 's' : ''} discarded — no resolvable evidence`
  );

  toggle.appendChild(arrow);
  toggle.appendChild(label);

  const list = document.createElement('div');
  list.id = 'dropped-list';

  dropped.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'dropped-entry';
    row.innerHTML = `
      <span class="dropped-mechanism">${escapeHtml(entry.proposed_mechanism)}</span>
      <span class="dropped-reason">${escapeHtml(entry.reason)}</span>
    `;
    list.appendChild(row);
  });

  toggle.addEventListener('click', () => {
    const isOpen = list.classList.toggle('open');
    arrow.classList.toggle('open', isOpen);
    toggle.setAttribute('aria-expanded', String(isOpen));
  });

  section.appendChild(toggle);
  section.appendChild(list);
  return section;
}

// ── Export JSON ───────────────────────────────────────────────────────────────

function exportJson(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'hookprint-findings.json';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Render ────────────────────────────────────────────────────────────────────

function render(data) {
  // ── Risk summary counts ──
  const counts = { high: 0, medium: 0, low: 0 };
  data.findings.forEach(f => { if (counts[f.confidence] !== undefined) counts[f.confidence]++; });

  // Build risk bar HTML
  const riskBarHtml = ['high', 'medium', 'low']
    .filter(c => counts[c] > 0)
    .map(c => {
      const blocks = Array(counts[c]).fill(`<span class="risk-block ${c}"></span>`).join('');
      return `
        <span class="risk-item ${c}">
          <span class="risk-dot ${c}"></span>
          <span class="risk-blocks">${blocks}</span>
          ${counts[c]} ${c.toUpperCase()}
        </span>
      `;
    }).join('');

  // ── Header ──
  const header = document.getElementById('panel-header');
  header.innerHTML = `
    <div class="header-wordmark">HOOKPRINT — Bill of Materials</div>
    <div class="header-url">${escapeHtml(data.url)}</div>
    <div class="header-risk-bar">${riskBarHtml}</div>
    <div class="header-meta">
      <span>${data.findings.length} finding${data.findings.length !== 1 ? 's' : ''} detected</span>
      <span class="header-freshness">scanned ${timeAgo(data.scanned_at)}</span>
    </div>
  `;

  // ── Toast placeholder ──
  _toastEl = document.createElement('div');
  _toastEl.id = 'action-toast';

  const list = document.getElementById('findings-list');
  list.appendChild(_toastEl);

  // ── Finding cards ──
  // High confidence open by default, medium/low collapsed
  data.findings.forEach(finding => {
    const isOpen = finding.confidence === 'high';
    list.appendChild(buildFindingCard(finding, isOpen));
  });

  // ── Dropped section ──
  if (data.dropped && data.dropped.length > 0) {
    list.appendChild(buildDroppedSection(data.dropped));
  }

  // ── Export button ──
  const footer = document.getElementById('panel-footer');
  footer.innerHTML = `<span>HOOKPRINT v0.1 — diagnostic instrument</span>`;
  const exportBtn = document.createElement('button');
  exportBtn.className = 'footer-export';
  exportBtn.textContent = '[EXPORT JSON]';
  exportBtn.addEventListener('click', () => exportJson(data));
  footer.appendChild(exportBtn);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

fetch('./fixture.json')
  .then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
  .then(data => render(data))
  .catch(err => {
    console.error('[HOOKPRINT] Failed to load fixture.json:', err);
    document.getElementById('panel-header').innerHTML = `
      <div class="header-wordmark">HOOKPRINT</div>
      <div style="color:#e03c3c;font-family:monospace;font-size:12px;padding:8px 0;">
        Error loading fixture.json — is the local server running?<br>
        <code>cd ui &amp;&amp; python -m http.server 5500</code>
      </div>
    `;
  });
