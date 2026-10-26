'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  path: '',
  page: 1,
  totalPages: 1,
  imageNames: [],
  showNonImages: true,
  lb: {
    open: false,
    index: 0,
    zoom: 1,     // 1 = 100%
    rotate: 0,     // degrees, multiple of 90
    panX: 0,
    panY: 0,
  },
};

const ZOOM_MIN = 1;
const ZOOM_MAX = 6;
const ZOOM_STEP = 0.4;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const grid = $('grid');
const pagination = $('pagination');
const breadcrumb = $('breadcrumb');
const statusBar = $('statusBar');
const toggleBtn = $('toggleNonImages');
const toggleMasonryBtn = $('toggleMasonry');

const lightbox = $('lightbox');
const lbStage = $('lbStage');
const lbImgWrap = $('lbImgWrap');
const lbImg = $('lbImg');
const lbSpinner = $('lbSpinner');
const lbCaption = $('lbCaption');
const lbCounter = $('lbCounter');
const lbPrev = $('lbPrev');
const lbNext = $('lbNext');
const lbClose = $('lbClose');
const lbOpenExplorer = $('lbOpenExplorer');
const lbBackdrop = $('lbBackdrop');

const lbZoomIn = $('lbZoomIn');
const lbZoomOut = $('lbZoomOut');
const lbZoomLevel = $('lbZoomLevel');
const lbRotateLeft = $('lbRotateLeft');
const lbRotateRight = $('lbRotateRight');
const lbReset = $('lbReset');

// ── API ───────────────────────────────────────────────────────────────────────
async function fetchList(path, page) {
  const params = new URLSearchParams({ path, page });
  const res = await fetch(`/api/list?${params}`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

function thumbURL(path, file, size) {
  return `/api/file?${new URLSearchParams({ path, file })}${size ? `&size=${size}` : ""}`;
}

// ── Navigation ────────────────────────────────────────────────────────────────
async function navigate(path, page = 1) {
  state.path = path;
  state.page = page;
  await loadPage();
}

async function loadPage() {
  renderLoading();
  try {
    const data = await fetchList(state.path, state.page);
    state.totalPages = data.totalPages;
    state.page = data.page;
    state.imageNames = data.imageNames;
    renderBreadcrumb(data.breadcrumb);
    renderStatus(data);
    renderGrid(data.items);
    renderPagination(data.page, data.totalPages);
    const url = new URL(location.href);
    url.searchParams.set('path', state.path);
    url.searchParams.set('page', String(state.page));
    history.pushState({ path: state.path, page: state.page }, '', url);
  } catch (err) {
    renderError(err.message);
  }
}

// ── Rendering: Breadcrumb ─────────────────────────────────────────────────────
function renderBreadcrumb(parts) {
  breadcrumb.innerHTML = '';
  for (const part of parts) {
    const item = document.createElement('span');
    item.className = 'bc-item';
    const link = document.createElement('span');
    link.className = 'bc-link';
    link.textContent = part.name;
    link.dataset.path = part.path;
    link.addEventListener('click', () => navigate(part.path));
    item.appendChild(link);
    breadcrumb.appendChild(item);
  }
}

// ── Rendering: Status bar ─────────────────────────────────────────────────────
function renderStatus(data) {
  const imgCount = data.imageNames.length;
  const totalItems = data.totalItems;

  statusBar.innerHTML = `
    <span><span class="count-accent">${totalItems}</span> items</span>
    <span><span class="count-accent">${imgCount}</span> images</span>
    ${data.totalPages > 1
      ? `<span>page <span class="count-accent">${data.page}</span> / ${data.totalPages}</span>`
      : ''}
  `;
}

// ── Rendering: Grid ───────────────────────────────────────────────────────────
function renderLoading() {
  grid.innerHTML = `<div class="grid-loading"><div class="spinner"></div><span>loading…</span></div>`;
  pagination.innerHTML = '';
}

function renderError(msg) {
  grid.innerHTML = `<div class="empty-state">⚠ ${msg}</div>`;
}

function renderGrid(items) {
  if (!items.length) {
    grid.innerHTML = '<div class="empty-state">No items in this folder.</div>';
    return;
  }

  grid.innerHTML = '';
  const frag = document.createDocumentFragment();

  items.forEach(item => {
    let card;
    if (item.type === 'dir') {
      card = makeDir(item);
    } else if (item.type === 'image') {
      card = makeImage(item);
    } else {
      card = makeFile(item);
    }

    if ((item.type === 'file' || item.type === 'dir') && !state.showNonImages) {
      card.classList.add('hidden-non-image');
    }

    frag.appendChild(card);
  });

  grid.appendChild(frag);
}

function makeDir(item) {
  const card = document.createElement('div');
  card.className = 'card card-dir';
  card.title = item.name;
  card.innerHTML = `
    <div class="card-icon">📁</div>
    <div class="card-name">${escHtml(item.name)}</div>
  `;
  card.addEventListener('click', () => {
    const newPath = state.path ? `${state.path}/${item.name}` : item.name;
    navigate(newPath);
  });
  return card;
}

function makeFile(item) {
  const card = document.createElement('div');
  card.className = 'card card-file';
  card.title = item.name;
  const icon = fileIcon(item.ext);
  card.innerHTML = `
    <div class="card-icon">${icon}</div>
    <div class="card-name">${escHtml(item.name)}</div>
  `;
  return card;
}

function makeImage(item) {
  const card = document.createElement('div');
  card.className = 'card card-image';
  card.title = item.name;

  const wrap = document.createElement('div');
  wrap.className = 'thumb-wrap';

  const ph = document.createElement('div');
  ph.className = 'thumb-placeholder';
  ph.textContent = '⬜';
  wrap.appendChild(ph);

  const img = document.createElement('img');
  img.alt = item.name;
  img.loading = 'lazy';
  img.decoding = 'async';

  img.addEventListener('load', () => {
    img.classList.add('loaded');
    ph.style.display = 'none';
  });
  img.addEventListener('error', () => {
    ph.textContent = '✕';
  });
  img.src = thumbURL(state.path, item.name, 200);
  wrap.appendChild(img);

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = item.name;

  card.appendChild(wrap);
  card.appendChild(name);

  card.addEventListener('click', () => {
    const imgIndex = state.imageNames.indexOf(item.name);
    openLightbox(imgIndex >= 0 ? imgIndex : 0);
  });

  return card;
}

// ── Rendering: Pagination ─────────────────────────────────────────────────────
function renderPagination(page, total) {
  pagination.innerHTML = '';
  if (total <= 1) return;

  const frag = document.createDocumentFragment();

  function btn(label, targetPage, isCurrent = false, disabled = false) {
    const b = document.createElement('button');
    b.className = 'pg-btn' + (isCurrent ? ' current' : '');
    b.textContent = label;
    b.disabled = disabled || isCurrent;
    if (!disabled && !isCurrent) {
      b.addEventListener('click', () => navigate(state.path, targetPage));
    }
    return b;
  }

  function ellipsis() {
    const s = document.createElement('span');
    s.className = 'pg-ellipsis';
    s.textContent = '…';
    return s;
  }

  frag.appendChild(btn('‹ Prev', page - 1, false, page === 1));

  const pages = computePageRange(page, total);
  let last = 0;
  for (const p of pages) {
    if (p - last > 1) frag.appendChild(ellipsis());
    frag.appendChild(btn(String(p), p, p === page));
    last = p;
  }
  if (total - last > 0) frag.appendChild(ellipsis());

  frag.appendChild(btn('Next ›', page + 1, false, page === total));
  pagination.appendChild(frag);
}

function computePageRange(current, total) {
  const show = new Set([1, total]);
  for (let d = -2; d <= 2; d++) {
    const p = current + d;
    if (p >= 1 && p <= total) show.add(p);
  }
  return [...show].sort((a, b) => a - b);
}

function toggleMasonry() {
  grid.classList.toggle('grid-lanes')
}

function openExplorer() {
  const url = `${lbImg.src}&open-explorer`;
  fetch(url).then(async res => { if (!(await res.json()).done) { showToast('could not open explorer') } });
}

// ── Toggle non-images ─────────────────────────────────────────────────────────
toggleBtn.addEventListener('click', () => {
  state.showNonImages = !state.showNonImages;
  toggleBtn.classList.toggle('active', !state.showNonImages);
  toggleBtn.querySelector('.btn-label').textContent =
    state.showNonImages ? 'Hide files' : 'Show files';

  grid.querySelectorAll('.card-file, .card-dir').forEach(card => {
    card.classList.toggle('hidden-non-image', !state.showNonImages);
  });
});

// ── Toggle masonry ────────────────────────────────────────────────────────────
toggleMasonryBtn.addEventListener('click', toggleMasonry)


// ── Lightbox: open / close ────────────────────────────────────────────────────
function openLightbox(index) {
  state.lb.open = true;
  lightbox.hidden = false;
  document.body.style.overflow = 'hidden';
  showLbImage(index, /*resetTransform*/ true);
}

function closeLightbox() {
  state.lb.open = false;
  lightbox.hidden = true;
  document.body.style.overflow = '';
  lbImg.src = '';
}

function showLbImage(index, resetTransform = true) {
  const images = state.imageNames;
  if (!images.length) return;
  const clamp = i => Math.max(0, Math.min(images.length - 1, i));
  index = clamp(index);
  state.lb.index = index;

  if (resetTransform) resetLbTransform(/*apply*/ false);

  const name = images[index];
  lbCaption.textContent = name;
  lbCounter.textContent = `${index + 1} / ${images.length}`;
  lbPrev.disabled = index === 0;
  lbNext.disabled = index === images.length - 1;

  lbImg.classList.add('fading');
  lbSpinner.classList.add('visible');

  const url = thumbURL(state.path, name);
  const tmp = new Image();
  tmp.onload = tmp.onerror = () => {
    lbImg.src = url;
    lbImg.alt = name;
    lbImg.classList.remove('fading');
    lbSpinner.classList.remove('visible');
    applyLbTransform();
  };
  tmp.src = url;
}

function lbStep(delta) {
  showLbImage(state.lb.index + delta, /*resetTransform*/ true);
}

lbClose.addEventListener('click', closeLightbox);
lbBackdrop.addEventListener('click', closeLightbox);
lbPrev.addEventListener('click', () => lbStep(-1));
lbNext.addEventListener('click', () => lbStep(1));
lbOpenExplorer.addEventListener('click', openExplorer);

// ── Lightbox: zoom / rotate / pan ─────────────────────────────────────────────
function applyLbTransform() {
  const { zoom, rotate, panX, panY } = state.lb;
  lbImg.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom}) rotate(${rotate}deg)`;
  lbZoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  lbImgWrap.classList.toggle('zoomed', zoom > 1);
  lbZoomOut.disabled = zoom <= ZOOM_MIN;
  lbZoomIn.disabled = zoom >= ZOOM_MAX;
}

function resetLbTransform(apply = true) {
  state.lb.zoom = 1;
  state.lb.rotate = 0;
  state.lb.panX = 0;
  state.lb.panY = 0;
  if (apply) applyLbTransform();
}

function setZoom(newZoom) {
  const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
  // When returning to 1x, also clear pan so image re-centers
  if (clamped <= ZOOM_MIN) {
    state.lb.panX = 0;
    state.lb.panY = 0;
  }
  state.lb.zoom = clamped;
  applyLbTransform();
}

function zoomBy(delta) { setZoom(state.lb.zoom + delta); }

function rotateBy(deg) {
  state.lb.rotate = (state.lb.rotate + deg + 360) % 360;
  applyLbTransform();
}

lbZoomIn.addEventListener('click', () => zoomBy(ZOOM_STEP));
lbZoomOut.addEventListener('click', () => zoomBy(-ZOOM_STEP));
lbRotateLeft.addEventListener('click', () => rotateBy(-90));
lbRotateRight.addEventListener('click', () => rotateBy(90));
lbReset.addEventListener('click', () => resetLbTransform(true));

// Scroll wheel to zoom (centered on cursor would require more math;
// this is a simple uniform zoom which keeps things predictable with pan/rotate combined)
lbStage.addEventListener('wheel', e => {
  if (!state.lb.open) return;
  e.preventDefault();
  const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
  zoomBy(delta);
}, { passive: false });

// Double-click to toggle zoom in/out
lbImgWrap.addEventListener('dblclick', () => {
  if (state.lb.zoom > 1) {
    setZoom(1);
  } else {
    setZoom(2.2);
  }
});

// Drag to pan when zoomed in (mouse)
(function () {
  let dragging = false;
  let startX = 0, startY = 0;
  let originX = 0, originY = 0;

  lbImgWrap.addEventListener('mousedown', e => {
    if (state.lb.zoom <= 1) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    originX = state.lb.panX; originY = state.lb.panY;
    lbImgWrap.classList.add('panning');
    lbImg.classList.add('no-transition');
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    state.lb.panX = originX + (e.clientX - startX);
    state.lb.panY = originY + (e.clientY - startY);
    applyLbTransform();
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    lbImgWrap.classList.remove('panning');
    lbImg.classList.remove('no-transition');
  });
})();

// Touch: swipe to navigate (when not zoomed), drag to pan (when zoomed),
// pinch to zoom.
(function () {
  let mode = null;          // 'swipe' | 'pan' | 'pinch'
  let startX = 0, startY = 0;
  let originX = 0, originY = 0;
  let startDist = 0;
  let startZoom = 1;

  function dist(t0, t1) {
    return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
  }

  lbStage.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      mode = 'pinch';
      startDist = dist(e.touches[0], e.touches[1]);
      startZoom = state.lb.zoom;
      lbImg.classList.add('no-transition');
    } else if (e.touches.length === 1) {
      mode = state.lb.zoom > 1 ? 'pan' : 'swipe';
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      originX = state.lb.panX;
      originY = state.lb.panY;
      if (mode === 'pan') lbImg.classList.add('no-transition');
    }
  }, { passive: true });

  lbStage.addEventListener('touchmove', e => {
    if (mode === 'pinch' && e.touches.length === 2) {
      const d = dist(e.touches[0], e.touches[1]);
      const ratio = d / startDist;
      setZoom(startZoom * ratio);
    } else if (mode === 'pan' && e.touches.length === 1) {
      state.lb.panX = originX + (e.touches[0].clientX - startX);
      state.lb.panY = originY + (e.touches[0].clientY - startY);
      applyLbTransform();
    }
  }, { passive: true });

  lbStage.addEventListener('touchend', e => {
    if (mode === 'swipe') {
      const dx = (e.changedTouches[0]?.clientX ?? startX) - startX;
      if (Math.abs(dx) > 50) lbStep(dx < 0 ? 1 : -1);
    }
    lbImg.classList.remove('no-transition');
    mode = null;
  }, { passive: true });
})();

// Keyboard navigation + zoom/rotate shortcuts
document.addEventListener('keydown', e => {
  if (e.altKey && e.key === 'g') {
    toggleMasonry();
  }
  if (!state.lb.open) return;
  switch (e.key) {
    case 'Escape': closeLightbox(); break;
    case 'ArrowLeft': lbStep(-1); break;
    case 'ArrowRight': lbStep(1); break;
    case 'Home': showLbImage(0); break;
    case 'End': showLbImage(state.imageNames.length - 1); break;
    case '+':
    case '=': zoomBy(ZOOM_STEP); break;
    case '-':
    case '_': zoomBy(-ZOOM_STEP); break;
    case '0': resetLbTransform(true); break;
    case 'r':
    case 'R': rotateBy(e.shiftKey ? -90 : 90); break;
    default: return;
  }
  e.preventDefault();
});

// ── Browser history ───────────────────────────────────────────────────────────
window.addEventListener('popstate', e => {
  const s = e.state;
  if (s) navigate(s.path, s.page);
  else navigate('', 1);
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fileIcon(ext) {
  const map = {
    pdf: '📄', txt: '📝', md: '📝', doc: '📝', docx: '📝',
    xls: '📊', xlsx: '📊', csv: '📊',
    ppt: '📋', pptx: '📋',
    zip: '🗜', gz: '🗜', tar: '🗜', rar: '🗜', '7z': '🗜',
    mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵',
    js: '⚙️', ts: '⚙️', py: '⚙️', sh: '⚙️', json: '⚙️',
    html: '🌐', css: '🎨', xml: '🌐',
    ttf: '🔤', otf: '🔤', woff: '🔤', woff2: '🔤',
    exe: '⚡', dmg: '⚡', deb: '⚡', apk: '⚡',
  };
  return map[ext] || '📎';
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, duration = 3000) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(function init() {
  const url = new URL(location.href);
  const path = url.searchParams.get('path') || '';
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  navigate(path, page);
})();
