'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  settings: null,
  env: null,
  jobs: new Map(),
  running: false,
  startedAt: 0,
  totalDuration: 0,
  runningIds: new Set(),
  lastOutputPath: null,
  outputDirOk: false,
  outputDirReason: '',
};

function locale() {
  return state.settings?.locale === 'en' ? 'en' : 'ru';
}

function t(key, vars) {
  return window.I18n.t(locale(), key, vars);
}

function filesWord(n) {
  if (locale() === 'en') {
    return `${n} ${t(n === 1 ? 'word.file.one' : 'word.file.other')}`;
  }
  return plural(n, t('word.file.one'), t('word.file.few'), t('word.file.many'));
}

function lockedMessage() {
  return t('adv.lock.short');
}

const MASCOT_BASE = [
  '................',
  '..X..........X..',
  '..XX........XX..',
  '..XPX......XPX..',
  '..XPPXXXXXXPPX..',
  '..XPPPPPPPPPPX..',
  '..XPPPPPPPPPPX..',
  '..XPePPPPPPePX..',
  '..XPPPPRRPPPPX..',
  '..XPPPPPPPPPPX..',
  '...XPPPPPPPPX...',
  '....XXPPPPXX....',
  '......XXXX......',
  '................',
];

const MASCOT_COLORS = { X: '#5c2a63', P: '#ff5fa2', W: '#fff6fb', R: '#d63d80' };
const MASCOT_EYES = { idle: 'X', busy: 'W', happy: 'R' };

function drawMascot(mood) {
  const eye = MASCOT_EYES[mood] || 'W';
  const rects = [];
  MASCOT_BASE.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      const key = cell === 'e' ? eye : cell;
      const color = MASCOT_COLORS[key];
      if (color) rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`);
    });
  });
  const svg = $('#mascot');
  svg.innerHTML = rects.join('');
  svg.setAttribute('class', `mascot mascot--${mood}`);
}

// --- Icons ---

const ICONS = {
  hourglass: '<svg class="icon" viewBox="0 0 16 16"><path fill="#5c2a63" d="M3 1h10v2H3zM3 13h10v2H3zM4 3h2v2H4zM10 3h2v2h-2zM6 5h4v2H6zM7 7h2v2H7zM6 9h4v2H6zM4 11h2v2H4zM10 11h2v2h-2z"/></svg>',
  gear: '<svg class="icon icon--spin" viewBox="0 0 16 16"><path fill="#5c2a63" d="M6 1h4v2H6zM6 13h4v2H6zM1 6h2v4H1zM13 6h2v4h-2zM3 3h2v2H3zM11 3h2v2h-2zM3 11h2v2H3zM11 11h2v2h-2zM6 6h4v4H6z"/></svg>',
  heart: '<svg class="icon" viewBox="0 0 16 16"><path fill="#2fa87d" d="M2 4h3v2H2zM5 2h3v2H5zM8 2h3v2H8zM11 4h3v2h-3zM2 6h12v2H2zM3 8h10v2H3zM4 10h8v2H4zM6 12h4v2H6z"/></svg>',
  broken: '<svg class="icon" viewBox="0 0 16 16"><path fill="#fff" d="M2 4h3v2H2zM5 2h3v2H5zM8 2h3v2H8zM11 4h3v2h-3zM2 6h5v2H2zM9 6h5v2H9zM3 8h5v2H3zM8 8h5v2H8zM4 10h8v2H4zM6 12h4v2H6z"/></svg>',
  skip: '<svg class="icon" viewBox="0 0 16 16"><path fill="#5c2a63" d="M2 3h3v10H2zM6 7h5v2H6zM11 4h2v8h-2z"/></svg>',
  stop: '<svg class="icon" viewBox="0 0 16 16"><path fill="#5c2a63" d="M4 4h8v8H4z"/></svg>',
};

function statusMeta(status) {
  const icons = {
    pending: ICONS.hourglass,
    running: ICONS.gear,
    done: ICONS.heart,
    error: ICONS.broken,
    skipped: ICONS.skip,
    cancelled: ICONS.stop,
  };
  return {
    label: t(`status.${status}`),
    icon: icons[status] || ICONS.hourglass,
    cls: status,
  };
}

function modes() {
  return {
    copy: {
      title: t('mode.copy.title'),
      summary: t('mode.copy.summary'),
      desc: t('mode.copy.desc'),
      tip: t('mode.copy.tip'),
      facts: [
        [t('mode.fact.quality'), t('mode.copy.quality')],
        [t('mode.fact.note'), t('mode.copy.note')],
      ],
    },
    deinterlace: {
      title: t('mode.enc.title'),
      summary: t('mode.enc.summary'),
      desc: t('mode.enc.desc'),
      tip: t('mode.enc.tip'),
      facts: [
        [t('mode.fact.quality'), t('mode.enc.quality')],
        [t('mode.fact.note'), t('mode.enc.note')],
      ],
    },
  };
}

// --- Tooltips ---

let tipEl = null;
let tipHost = null;

function initTooltips() {
  tipEl = document.createElement('div');
  tipEl.className = 'tip';
  tipEl.hidden = true;
  document.body.append(tipEl);

  document.addEventListener('mouseover', (e) => {
    const host = e.target.closest?.('[data-tip]');
    if (host !== tipHost) host ? showTip(host) : hideTip();
  });
  document.addEventListener('mousedown', hideTip);
  document.addEventListener('wheel', hideTip, { passive: true });
  window.addEventListener('blur', hideTip);
}

function showTip(host) {
  const text = host.dataset.tip;
  if (!text) return;

  tipHost = host;
  tipEl.textContent = text;
  tipEl.hidden = false;

  const anchor = host.getBoundingClientRect();
  const tip = tipEl.getBoundingClientRect();
  const gap = 10;

  const left = Math.min(
    Math.max(8, anchor.left + anchor.width / 2 - tip.width / 2),
    window.innerWidth - tip.width - 8,
  );
  const above = anchor.top - tip.height - gap;
  const top = above >= 8 ? above : anchor.bottom + gap;

  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
}

function hideTip() {
  if (!tipEl) return;
  tipEl.hidden = true;
  tipHost = null;
}

// --- Formatting ---

function formatSize(bytes) {
  if (!bytes) return '—';
  const units = [t('unit.b'), t('unit.kb'), t('unit.mb'), t('unit.gb')];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return t('eta.ltMin');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('eta.min', { n: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? t('eta.hrMin', { h: hours, m: rest }) : t('eta.hr', { h: hours });
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} ${few}`;
  return `${n} ${many}`;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// --- Toasts and modal ---

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind ? `toast--${kind}` : ''}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

let modalResolve = null;

function openModal(title, html, choices) {
  return new Promise((resolve) => {
    closeModal();
    modalResolve = resolve;

    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;

    const actions = $('#modal-actions');
    actions.innerHTML = '<span class="spacer"></span>';
    for (const choice of choices) {
      const button = document.createElement('button');
      button.className = `btn ${choice.cls || ''}`.trim();
      button.textContent = choice.label;
      if (choice.tip) button.dataset.tip = choice.tip;
      button.addEventListener('click', () => closeModal(choice.value));
      actions.append(button);
    }

    $('#modal').hidden = false;
  });
}

// Dismissing the window without picking anything resolves to null.
function closeModal(value = null) {
  $('#modal').hidden = true;
  hideTip();
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) resolve(value);
}

function showModal(title, html) {
  openModal(title, html, [{ label: t('modal.close'), value: null }]);
}

// --- Mode cards ---

function renderModeCards(container, { showRecommendation } = {}) {
  if (!container) return;
  const recommended = recommendedMode();
  container.innerHTML = Object.entries(modes())
    .map(([key, mode]) => {
      const selected = state.settings.mode === key ? ' is-selected' : '';
      const tag = showRecommendation && recommended === key
        ? `<span class="recommend-tag">${t('mode.recommend')}</span>`
        : '';
      const facts = mode.facts
        .map(([k, v]) => `<div class="mode-card__fact"><span class="muted">${k}:</span> <b>${v}</b></div>`)
        .join('');
      return `
        <div class="mode-card${selected}" data-mode="${key}" role="button" tabindex="0"
             data-tip="${escapeHtml(mode.tip)}">
          ${tag}
          <div class="mode-card__title">${mode.title}</div>
          <div class="mode-card__summary small">${mode.summary}</div>
          <div class="mode-card__desc">${mode.desc}</div>
          <div class="mode-card__facts">${facts}</div>
        </div>`;
    })
    .join('');

  container.classList.toggle('is-locked', state.running);

  container.querySelectorAll('.mode-card').forEach((card) => {
    const choose = () => {
      if (state.running) {
        toast(lockedMessage(), 'error');
        return;
      }
      patchSettings({ mode: card.dataset.mode });
      renderAllModeCards();
      renderJobs();
    };
    card.addEventListener('click', choose);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        choose();
      }
    });
  });
}

function recommendedMode() {
  const jobs = [...state.jobs.values()];
  if (!jobs.length) return 'copy';
  return jobs.some((job) => job.analysis && !job.analysis.canCopy) ? 'deinterlace' : 'copy';
}

function renderAllModeCards() {
  renderModeCards($('#main-cards'), { showRecommendation: true });
  if (!$('#screen-onboarding').hidden) {
    renderModeCards($('#onboarding-cards'), { showRecommendation: true });
  }
}

// --- Settings ---

async function patchSettings(partial) {
  state.settings = await window.api.settings.patch(partial);
  return state.settings;
}

function applySettingsToUI() {
  const s = state.settings;

  $$('input[name="audio"]').forEach((el) => (el.checked = el.value === s.audio));
  $('#opt-deinterlace').checked = s.deinterlace;
  $('#opt-normalize').checked = s.normalizePixels;
  $('#opt-crf').value = s.crf;
  updateCrfHint();
}

// --- Output folder ---

function outputDirReady() {
  return Boolean(state.settings.outputDir) && state.outputDirOk;
}

function renderOutputDir() {
  const dir = state.settings.outputDir;
  const ready = outputDirReady();

  $('#outbox').classList.toggle('is-required', !ready);
  $('#outbox-tag').textContent = ready ? t('out.chosen') : t('out.required');
  $('#outbox-path').innerHTML = ready
    ? splitPathHtml(dir)
    : `<span>${escapeHtml(dir ? state.outputDirReason : t('out.empty'))}</span>`;
  $('#outbox-path').title = dir || '';
  $('#pick-output').textContent = ready ? t('out.change') : t('out.pick');
  $('#open-output').hidden = !ready;

  updateStartButton();
}

function splitPathHtml(dir) {
  const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
  const head = cut > 0 ? dir.slice(0, cut + 1) : '';
  const tail = cut > 0 ? dir.slice(cut + 1) : dir;
  return `<span class="outbox__path-head">${escapeHtml(head)}</span><span class="outbox__path-tail">${escapeHtml(tail)}</span>`;
}

async function refreshOutputDir() {
  const dir = state.settings.outputDir;
  const check = dir ? await window.api.checkDir(dir) : { ok: false, reason: t('out.missing') };
  state.outputDirOk = check.ok;
  state.outputDirReason = check.reason;
  renderOutputDir();
  return check.ok;
}

function updateCrfHint() {
  const crf = Number($('#opt-crf').value);
  $('#crf-value').textContent = crf;
  $('#crf-hint').textContent =
    crf <= 14 ? t('crf.near')
      : crf <= 17 ? t('crf.same')
        : crf <= 20 ? t('crf.good')
          : t('crf.save');
}

// --- File list ---

function renderJobs() {
  const body = $('#files-body');
  const jobs = [...state.jobs.values()];

  $('#dropzone').classList.toggle('is-compact', jobs.length > 0);
  $('#clear-files').hidden = jobs.length === 0 || state.running;
  $('#files-head-label').hidden = !$('#clear-files').hidden;

  if (!jobs.length) {
    body.innerHTML = `<div class="files__empty">${t('table.empty')}</div>`;
    updateStartButton();
    return;
  }

  body.innerHTML = jobs.map(jobRowHtml).join('');
  body.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleRowAction(btn.dataset.action, btn.dataset.id));
  });
  updateStartButton();
}

function jobRowHtml(job) {
  const meta = statusMeta(job.status);
  const info = job.info;
  const mode = plannedModeFor(job);

  const inside = info
    ? `${info.displayWidth}x${info.displayHeight}${info.interlaced ? ` · ${t('row.interlaced')}` : ''}<br />${info.codec.toUpperCase()}${info.audioCodec ? ` + ${info.audioCodec.toUpperCase()} ${info.audioChannels}ch` : ''}`
    : `<span class="muted">${t('row.unreadable')}</span>`;

  const percent = Math.round((job.progress || 0) * 100);
  let progressCell;
  if (job.status === 'running') {
    progressCell = `
      <div class="file-progress">
        <div class="progress"><div class="progress__fill" style="width:${percent}%"></div></div>
        <div class="file-progress__meta">${job.stage || t('stage.convert')} · ${percent}%${job.speed ? ` · ${job.speed.toFixed(1)}x` : ''}</div>
      </div>`;
  } else if (job.status === 'done') {
    const headline = job.plannedMode === 'copy' ? t('row.lossless') : t('row.done');
    const tooltip = [...(job.verification?.details || []), t('row.was', { size: formatSize(job.inputSize) })].join(', ');
    progressCell = `<div class="file-progress__meta" title="${escapeHtml(tooltip)}">${headline}<br />${formatSize(job.outputSize)}</div>`;
  } else if (job.status === 'error') {
    progressCell = `<div class="file-progress__meta" style="color:var(--coral-dark)">${escapeHtml(job.error || t('status.error'))}</div>`;
  } else if (job.status === 'skipped') {
    progressCell = `<div class="file-progress__meta">${t('row.exists')}</div>`;
  } else {
    progressCell = `<div class="file-progress__meta muted">${mode === 'copy' ? t('row.copy') : t('row.encode')}</div>`;
  }

  const actions = [];
  if (job.status === 'done') {
    actions.push(`<button class="btn btn--small" data-action="reveal" data-id="${job.id}">${t('row.show')}</button>`);
  }
  if (job.status === 'error' && job.log) {
    actions.push(`<button class="btn btn--small" data-action="log" data-id="${job.id}">${t('row.details')}</button>`);
  }
  if (!state.running && job.status !== 'running') {
    actions.push(`<button class="btn btn--small" data-action="remove" data-id="${job.id}">${t('row.remove')}</button>`);
  }
  if (state.running && (job.status === 'running' || job.status === 'pending')) {
    actions.push(`<button class="btn btn--small" data-action="cancel" data-id="${job.id}">${t('row.stop')}</button>`);
  }

  const rowClass = ['file-row', `is-${job.status}`].join(' ');

  return `
    <div class="${rowClass}" data-id="${job.id}">
      <div class="file-row__name">
        <div class="file-row__title" title="${escapeHtml(job.input)}">${escapeHtml(job.name)}</div>
        <div class="file-row__sub">
          <span class="badge badge--${meta.cls}">${meta.icon}${meta.label}</span>
          ${formatSize(job.inputSize)}
        </div>
      </div>
      <div>${info ? formatDuration(info.duration) : '—'}</div>
      <div class="small">${inside}</div>
      <div>${progressCell}</div>
      <div class="file-row__actions">${actions.join('')}</div>
    </div>`;
}

function plannedModeFor(job) {
  if (!job.analysis) return state.settings.mode;
  return job.analysis.canCopy ? state.settings.mode : 'deinterlace';
}

function handleRowAction(action, id) {
  const job = state.jobs.get(id);
  if (!job) return;

  if (action === 'reveal') {
    window.api.shell.revealFile(job.output);
  } else if (action === 'remove') {
    state.jobs.delete(id);
    window.api.files.remove([id]);
    renderJobs();
    renderAllModeCards();
  } else if (action === 'cancel') {
    window.api.queue.cancelJob(id);
  } else if (action === 'log') {
    showModal(
      t('modal.logTitle', { name: job.name }),
      `<p>${escapeHtml(job.error || '')}</p><div class="log-box">${escapeHtml(job.log || t('modal.logEmpty'))}</div>`,
    );
  }
}

// Normally only unfinished files; once everything is done, the whole list again.
function jobsToRun() {
  const withInfo = [...state.jobs.values()].filter((j) => j.info);
  const notDone = withInfo.filter((j) => j.status !== 'done');
  return { jobs: notDone.length ? notDone : withInfo, redo: notDone.length === 0 && withInfo.length > 0 };
}

function updateStartButton() {
  const { jobs, redo } = jobsToRun();
  const button = $('#btn-start');
  const needFolder = !outputDirReady();

  button.disabled = state.running || jobs.length === 0 || needFolder;
  button.textContent = state.running
    ? t('footer.working')
    : needFolder && jobs.length
      ? t('footer.needFolder')
      : redo
        ? t('footer.again')
        : jobs.length > 1
          ? t('footer.startN', { n: jobs.length })
          : t('footer.start');

  button.dataset.tip = state.running
    ? t('start.tip.run')
    : !jobs.length
      ? t('start.tip.empty')
      : needFolder
        ? t('start.tip.folder')
        : redo
          ? t('start.tip.again')
          : t('start.tip.go', { files: filesWord(jobs.length) });
}

// --- Adding files ---

async function addPaths(paths) {
  if (!paths.length || state.running) return;

  const status = $('#total-status');
  status.textContent = t('footer.reading');
  drawMascot('busy');

  try {
    const { added, skipped } = await window.api.files.add(paths);
    for (const job of added) state.jobs.set(job.id, job);

    renderJobs();
    renderAllModeCards();

    if (!state.settings.onboarded && [...state.jobs.values()].some((j) => j.analysis)) {
      showScreen('onboarding');
      renderModeCards($('#onboarding-cards'), { showRecommendation: true });
      renderOnboardingAnalysis();
      await patchSettings({ mode: recommendedMode() });
      renderAllModeCards();
    }

    const unreadable = added.filter((j) => !j.info).length;
    if (added.length) {
      toast(t('toast.added', { files: filesWord(added.length) }), 'good');
    } else if (!skipped) {
      toast(t('toast.none'), 'error');
    }
    if (skipped) toast(t('toast.dup', { n: skipped }));
    if (unreadable) toast(t('toast.unread', { n: unreadable }), 'error');
  } catch (err) {
    toast(t('toast.addFail', { message: err.message }), 'error');
  } finally {
    drawMascot('idle');
    updateTotals();
  }
}

// --- Running the queue ---

async function askOverwrite(names) {
  const shown = names.slice(0, 6).map((n) => `<div>· ${escapeHtml(n)}</div>`).join('');
  const rest = names.length > 6 ? `<div class="muted">${t('overwrite.more', { n: names.length - 6 })}</div>` : '';

  return openModal(
    t('overwrite.title'),
    `<p>${t('overwrite.body', { files: filesWord(names.length) })}</p>
     <div class="stack small">${shown}${rest}</div>
     <p>${t('overwrite.ask')}</p>`,
    [
      { label: t('overwrite.cancel'), value: null, cls: 'btn--ghost' },
      {
        label: t('overwrite.keep'),
        value: 'keep',
        cls: 'btn--lav',
        tip: t('overwrite.keep.tip'),
      },
      {
        label: t('overwrite.replace'),
        value: 'replace',
        cls: 'btn--primary',
        tip: t('overwrite.replace.tip'),
      },
    ],
  );
}

async function startConversion() {
  const ids = jobsToRun().jobs.map((j) => j.id);
  if (!ids.length) return;

  if (!(await refreshOutputDir())) {
    toast(t('out.need'), 'error');
    $('#outbox').scrollIntoView({ block: 'nearest' });
    return;
  }

  const existing = await window.api.queue.existing(ids);
  let overwrite = false;
  if (existing.length) {
    const answer = await askOverwrite(existing);
    if (answer === null) return;
    overwrite = answer === 'replace';
  }

  state.running = true;
  state.startedAt = Date.now();
  state.runningIds = new Set(ids);
  state.totalDuration = ids
    .map((id) => state.jobs.get(id))
    .reduce((sum, j) => sum + (j?.info?.duration || 0), 0);

  $('#btn-cancel').hidden = false;
  $('#btn-open-folder').hidden = true;
  drawMascot('busy');
  setControlsEnabled(false);
  renderJobs();

  try {
    await window.api.queue.start(ids, overwrite);
  } catch (err) {
    toast(err.message, 'error');
    state.running = false;
    $('#btn-cancel').hidden = true;
    setControlsEnabled(true);
    drawMascot('idle');
    renderJobs();
  }
}

function setControlsEnabled(enabled) {
  for (const id of ['#pick-files', '#pick-folder', '#clear-files', '#pick-output', '#opt-crf', '#opt-deinterlace', '#opt-normalize']) {
    const el = $(id);
    if (el) el.disabled = !enabled;
  }
  $$('input[name="audio"]').forEach((el) => (el.disabled = !enabled));

  $('#advanced').classList.toggle('is-locked', !enabled);
  $('#lock-note').hidden = enabled;
  $('#dropzone').classList.toggle('is-locked', !enabled);
  $$('.mode-cards').forEach((el) => el.classList.toggle('is-locked', !enabled));

  hideTip();
}

function updateTotals() {
  // Only files from the current run: leftovers from a previous one would
  // inflate the bar.
  const jobs = [...state.jobs.values()].filter(
    (j) => j.info && (!state.running || state.runningIds.has(j.id)),
  );
  const totalDuration = state.running
    ? state.totalDuration
    : jobs.reduce((sum, j) => sum + (j.info.duration || 0), 0);

  if (!jobs.length) {
    $('#total-fill').style.width = '0%';
    $('#total-status').textContent = t('footer.ready');
    return;
  }

  let processed = 0;
  for (const job of jobs) {
    const weight = job.info.duration || 0;
    if (job.status === 'done' || job.status === 'skipped') {
      processed += weight;
    } else if (state.running && (job.status === 'error' || job.status === 'cancelled')) {
      // While running these are done with; when idle the bar shows success only.
      processed += weight;
    } else if (job.status === 'running') {
      processed += weight * (job.progress || 0);
    }
  }

  const fraction = totalDuration > 0 ? Math.min(1, processed / totalDuration) : 0;
  $('#total-fill').style.width = `${Math.round(fraction * 100)}%`;

  if (!state.running) {
    const done = jobs.filter((j) => j.status === 'done').length;
    $('#total-status').textContent = done
      ? t('footer.doneOf', { done, total: jobs.length })
      : `${filesWord(jobs.length)} · ${formatDuration(totalDuration)}`;
    return;
  }

  const elapsed = (Date.now() - state.startedAt) / 1000;
  const eta = fraction > 0.02 ? (elapsed / fraction) * (1 - fraction) : NaN;
  const doneCount = jobs.filter((j) => ['done', 'skipped', 'error', 'cancelled'].includes(j.status)).length;
  const etaText = formatEta(eta);
  $('#total-status').textContent =
    `${doneCount} / ${jobs.length} · ${Math.round(fraction * 100)}%${etaText ? ` · ${etaText}` : ''}`;
}

// --- Onboarding screen ---

function renderOnboardingAnalysis() {
  const screen = $('#screen-onboarding');
  if (screen.hidden) return;

  const jobs = [...state.jobs.values()].filter((j) => j.analysis);
  const box = $('#onboarding-analysis');
  if (!jobs.length) {
    box.hidden = true;
    return;
  }

  const notes = new Map();
  for (const job of jobs) {
    for (const note of job.analysis.notes || []) {
      const text = typeof note === 'string' ? note : t(note.id, note);
      notes.set(text, (notes.get(text) || 0) + 1);
    }
  }

  const total = jobs.length;
  const lines = [`<b>${t('onboarding.looked', { files: filesWord(total) })}</b>`];
  for (const [note, count] of notes) {
    lines.push(`· ${escapeHtml(note)}${count < total ? ` (${count} / ${total})` : ''}`);
  }
  if (notes.size === 0) lines.push(`· ${t('onboarding.ok')}`);

  $('#onboarding-analysis-body').innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  box.hidden = false;
}

function showScreen(name) {
  $('#screen-onboarding').hidden = name !== 'onboarding';
  $('#screen-main').hidden = name !== 'main';
  $('#footer').hidden = name !== 'main';
}

function applyLocale() {
  window.I18n.applyDom(locale());
  $$('#lang-switch .lang__btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.locale === locale());
  });
  document.title = t('app.name');
  $('#env-info').textContent = state.env?.ffmpegVersion
    ? `FFmpeg ${state.env.ffmpegVersion}`
    : 'FFmpeg —';
  renderOutputDir();
  renderAllModeCards();
  renderJobs();
  renderOnboardingAnalysis();
  updateTotals();
  updateCrfHint();
}

async function setLocale(next) {
  if (next === locale()) return;
  await patchSettings({ locale: next });
  applyLocale();
}

// --- Init ---

async function init() {
  state.settings = await window.api.settings.get();
  if (!state.settings.locale) state.settings.locale = 'ru';
  state.env = await window.api.appInfo();

  drawMascot('idle');
  initTooltips();
  applySettingsToUI();
  await refreshOutputDir();
  applyLocale();

  if (!state.env.ffmpegVersion) {
    toast(t('toast.ffmpegMissing'), 'error');
  }

  showScreen('main');

  wireEvents();
  updateTotals();
}

function wireEvents() {
  $('#win-min').addEventListener('click', () => window.api.window.minimize());
  $('#win-max').addEventListener('click', () => window.api.window.maximize());
  $('#win-close').addEventListener('click', () => window.api.window.close());

  $$('#lang-switch .lang__btn').forEach((btn) => {
    btn.addEventListener('click', () => setLocale(btn.dataset.locale));
  });

  $('#onboarding-confirm').addEventListener('click', async () => {
    await patchSettings({ onboarded: true });
    showScreen('main');
    renderAllModeCards();
    updateTotals();
  });

  $('#pick-files').addEventListener('click', async () => {
    const paths = await window.api.dialog.pickFiles();
    await addPaths(paths);
  });

  $('#pick-folder').addEventListener('click', async () => {
    const folder = await window.api.dialog.pickFolder(t('dialog.pickVideos'));
    if (folder) await addPaths([folder]);
  });

  $('#clear-files').addEventListener('click', async () => {
    if (state.running) return;
    const count = state.jobs.size;
    if (!count) return;

    state.jobs.clear();
    state.runningIds.clear();
    state.lastOutputPath = null;
    await window.api.files.clear();

    $('#btn-open-folder').hidden = true;
    renderJobs();
    renderAllModeCards();
    updateTotals();
    toast(t('toast.cleared', { files: filesWord(count) }));
  });

  $('#pick-output').addEventListener('click', async () => {
    const folder = await window.api.dialog.pickFolder(t('dialog.pickOutput'));
    if (!folder) return;

    await patchSettings({ outputDir: folder });
    if (await refreshOutputDir()) toast(t('out.ready'), 'good');
    else toast(state.outputDirReason, 'error');
  });

  $('#open-output').addEventListener('click', () => {
    if (state.settings.outputDir) window.api.shell.openPath(state.settings.outputDir);
  });

  const dropzone = $('#dropzone');
  const over = (on) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.toggle('is-over', on);
  };
  ['dragenter', 'dragover'].forEach((evt) => document.addEventListener(evt, over(true)));
  ['dragleave', 'dragend'].forEach((evt) => document.addEventListener(evt, over(false)));

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-over');
    const paths = [...(e.dataTransfer?.files || [])]
      .map((file) => window.api.pathForFile(file))
      .filter(Boolean);
    await addPaths(paths);
  });

  $$('input[name="audio"]').forEach((el) =>
    el.addEventListener('change', () => patchSettings({ audio: el.value })),
  );

  for (const [sel, key] of [['#opt-deinterlace', 'deinterlace'], ['#opt-normalize', 'normalizePixels']]) {
    $(sel).addEventListener('change', (e) => patchSettings({ [key]: e.target.checked }));
  }

  // Disabled inputs swallow their own clicks, so the locked sheet over the grid
  // is what actually reports back to the user.
  $('#advanced').addEventListener('click', (e) => {
    if (state.running && e.target.closest('.advanced__grid')) toast(lockedMessage(), 'error');
  });

  $('#opt-crf').addEventListener('input', updateCrfHint);
  $('#opt-crf').addEventListener('change', (e) => patchSettings({ crf: Number(e.target.value) }));

  $('#btn-start').addEventListener('click', startConversion);
  $('#btn-cancel').addEventListener('click', () => {
    window.api.queue.cancel();
    toast(t('footer.stopping'));
  });
  $('#btn-open-folder').addEventListener('click', () => {
    if (state.lastOutputPath) window.api.shell.openFolderOf(state.lastOutputPath);
  });

  $('#modal').addEventListener('click', (e) => {
    if (e.target === $('#modal')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
  });

  window.api.on('files:scanning', ({ current, total, name }) => {
    $('#total-status').textContent = t('footer.readingOne', { current, total, name });
  });

  window.api.on('queue:job', (job) => {
    const existing = state.jobs.get(job.id);
    state.jobs.set(job.id, { ...existing, ...job, analysis: existing?.analysis });
    if (job.status === 'done') state.lastOutputPath = job.output;
    scheduleRender();
  });

  window.api.on('queue:started', ({ total }) => {
    toast(t('toast.go', { files: filesWord(total) }));
  });

  window.api.on('queue:finished', (summary) => {
    state.running = false;
    $('#btn-cancel').hidden = true;
    setControlsEnabled(true);
    renderJobs();
    updateTotals();

    if (summary.done) {
      drawMascot('happy');
      $('#btn-open-folder').hidden = false;
      setTimeout(() => drawMascot('idle'), 6000);
    } else {
      drawMascot('idle');
    }

    const parts = [];
    if (summary.done) parts.push(t('toast.done', { n: summary.done }));
    if (summary.failed) parts.push(t('toast.fail', { n: summary.failed }));
    if (summary.skipped) parts.push(t('toast.skip', { n: summary.skipped }));
    if (summary.cancelled) parts.push(t('toast.cancel', { n: summary.cancelled }));
    toast(parts.join(', ') || t('toast.nothing'), summary.failed ? 'error' : 'good');
  });

  window.api.on('window:state', ({ maximized }) => {
    $('#win-max').title = maximized ? t('win.restore') : t('win.max');
    $('#win-max').setAttribute('aria-label', $('#win-max').title);
  });
}

// ffmpeg reports progress often, so repaint at most 10 times per second.
let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderJobs();
    updateTotals();
  }, 100);
}

init().catch((err) => {
  document.body.innerHTML = `<div style="padding:40px;font-family:monospace">${escapeHtml(window.I18n.t('en', 'ui.fail', { message: err.message }))}</div>`;
});
