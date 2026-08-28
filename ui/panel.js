/* ── HOOKPRINT — Bill of Materials — panel.js ── */

// Task 5: Expose hook for Kevin's action handler.
// Kevin replaces onAction with his own implementation.
window.HOOKPRINT_UI = {
  onAction: (action_id) => {
    // Default no-op placeholder — Kevin will swap this out.
    console.log('[HOOKPRINT_UI] onAction called with:', action_id);
  }
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Given a full URL, returns just "filename.js:line"
 * Full URL is preserved in a title attribute for hover.
 */
function shortLocation(fileUrl, line) {
  try {
    const path = new URL(fileUrl).pathname;
    const filename = path.split('/').filter(Boolean).pop() || fileUrl;
    return { short: `${filename}:${line}`, full: fileUrl };
  } catch (_) {
    return { short: `${fileUrl}:${line}`, full: fileUrl };
  }
}

function formatScannedAt(iso) {
  try {
    const d = new Date(iso);
    return d.toUTCString().replace('GMT', 'UTC');
  } catch (_) {
    return iso;
  }
}

// ── Card builder ─────────────────────────────────────────────────────────────

function buildFindingCard(finding) {
  const card = document.createElement('div');
  card.className = 'finding-card';
  card.dataset.findingId = finding.id;

  // ── Mechanism row ──────────────────────────────────────
  const mechRow = document.createElement('div');
  mechRow.className = 'card-row card-mechanism';
  mechRow.innerHTML = `
    <div class="row-label">Mechanism</div>
    <div class="mechanism-name">${escapeHtml(finding.display_name)}</div>
  `;

  // ── Confidence row ─────────────────────────────────────
  const confRow = document.createElement('div');
  confRow.className = 'card-row card-confidence';
  const conf = finding.confidence.toLowerCase();
  confRow.innerHTML = `
    <div class="row-label">Confidence</div>
    <span class="confidence-badge ${escapeHtml(conf)}">${escapeHtml(finding.confidence)}</span>
  `;

  // ── Evidence row ───────────────────────────────────────
  const ev = finding.evidence;
  const loc = shortLocation(ev.file, ev.line);
  const evidRow = document.createElement('div');
  evidRow.className = 'card-row card-evidence';
  evidRow.innerHTML = `
    <div class="row-label">Evidence</div>
    <div class="evidence-location">
      <span class="evidence-filename" title="${escapeHtml(loc.full)}">${escapeHtml(loc.short)}</span>
    </div>
    <pre class="evidence-snippet">${escapeHtml(ev.snippet)}</pre>
  `;

  // ── Observed row ───────────────────────────────────────
  const obsRow = document.createElement('div');
  obsRow.className = 'card-row card-observed';
  obsRow.innerHTML = `
    <div class="row-label">Observed</div>
    <div class="observed-summary">${escapeHtml(finding.observed.summary)}</div>
  `;

  // ── Action row ─────────────────────────────────────────
  const actionRow = document.createElement('div');
  actionRow.className = 'card-row card-action';
  actionRow.innerHTML = `<div class="row-label">Action</div>`;

  if (finding.action.supported) {
    const btn = document.createElement('button');
    btn.className = 'action-btn';
    btn.textContent = finding.action.label;
    btn.dataset.actionId = finding.action.action_id;

    btn.addEventListener('click', () => {
      const action_id = btn.dataset.actionId;

      // Log to console (Task 5)
      console.log('[HOOKPRINT] Action fired:', action_id);

      // Call the exposed hook so Kevin can wire real behaviour later
      window.HOOKPRINT_UI.onAction(action_id);

      // Visually confirm — flip to DISABLED ✓ and lock
      btn.textContent = 'DISABLED ✓';
      btn.classList.add('disabled-state');
      btn.disabled = true;
    });

    actionRow.appendChild(btn);
  } else {
    // Task 3: supported: false → NOT SUPPORTED label, never a button
    const label = document.createElement('span');
    label.className = 'not-supported';
    label.textContent = 'NOT SUPPORTED';
    actionRow.appendChild(label);
  }

  card.appendChild(mechRow);
  card.appendChild(confRow);
  card.appendChild(evidRow);
  card.appendChild(obsRow);
  card.appendChild(actionRow);

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
  arrow.setAttribute('aria-hidden', 'true');

  const label = document.createTextNode(
    `${dropped.length} candidate mechanic${dropped.length !== 1 ? 's' : ''} discarded — no resolvable evidence`
  );

  toggle.appendChild(arrow);
  toggle.appendChild(label);

  const list = document.createElement('div');
  list.id = 'dropped-list';
  list.setAttribute('role', 'region');

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

// ── Render ────────────────────────────────────────────────────────────────────

function render(data) {
  // Header
  const header = document.getElementById('panel-header');
  header.innerHTML = `
    <div class="header-wordmark">HOOKPRINT — Bill of Materials</div>
    <div class="header-url">${escapeHtml(data.url)}</div>
    <div class="header-meta">
      <span><span class="header-count">${data.findings.length}</span> finding${data.findings.length !== 1 ? 's' : ''} detected</span>
      <span class="header-scanned">scanned ${escapeHtml(formatScannedAt(data.scanned_at))}</span>
    </div>
  `;

  // Finding cards
  const list = document.getElementById('findings-list');
  data.findings.forEach(finding => {
    list.appendChild(buildFindingCard(finding));
  });

  // Dropped section
  if (data.dropped && data.dropped.length > 0) {
    list.appendChild(buildDroppedSection(data.dropped));
  }
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
