'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  path: '',
  page: 1,
  totalPages: 1,
  imageNames: [],
  showNonImages: true,
  // Unified list of { dir, name } the lightbox can page through — rebuilt
  // whenever the folder view or a search result set loads, so prev/next
  // works the same way in both modes.
  lbSource: [],
  search: {
    active: false,
    query: '',
  },
  lb: {
    open: false,
    index: 0,
    zoom: 1,     // 1 = 100%
    rotate: 0,     // degrees, multiple of 90
    panX: 0,
    panY: 0,
    currentDir: undefined,
    currentName: undefined,
    tags: [],
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

const searchInput = $('searchInput');
const searchClear = $('searchClear');
const btnTags = $('btnTags');

const tagsModal = $('tagsModal');
const tagsModalBackdrop = $('tagsModalBackdrop');
const tagsModalClose = $('tagsModalClose');
const tagsModalBody = $('tagsModalBody');

const lbTagsList = $('lbTagsList');
const lbTagInput = $('lbTagInput');
const lbTagsStatus = $('lbTagsStatus');

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
  exitSearchUI();
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
    state.lbSource = data.imageNames.map(name => ({ dir: state.path, name }));
    renderBreadcrumb(data.breadcrumb);
    renderStatus(data);
    renderGrid(data.items);
    renderPagination(data.page, data.totalPages);
    const url = new URL(location.href);
    url.searchParams.set('path', state.path);
    url.searchParams.set('page', String(state.page));
    url.searchParams.delete('q');
    history.pushState({ path: state.path, page: state.page }, '', url);
  } catch (err) {
    renderError(err.message);
  }
}

// ── Search ────────────────────────────────────────────────────────────────────
async function fetchSearch(q) {
  const params = new URLSearchParams({ q });
  const res = await fetch(`/api/search?${params}`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

function exitSearchUI() {
  state.search.active = false;
  state.search.query = '';
  searchInput.value = '';
  searchClear.hidden = true;
}

async function runSearch(rawQuery, pushHistory = true) {
  const q = rawQuery.trim();
  if (!q) {
    exitSearchUI();
    await loadPage();
    return;
  }

  searchInput.value = rawQuery;
  searchClear.hidden = false;
  state.search.active = true;
  state.search.query = q;

  renderLoading();
  breadcrumb.innerHTML = '';
  pagination.innerHTML = '';

  try {
    const data = await fetchSearch(q);
    state.lbSource = data.items.map(it => ({ dir: it.dir, name: it.name }));
    renderSearchStatus(data);
    renderSearchGrid(data.items);
    if (pushHistory) {
      const url = new URL(location.href);
      url.searchParams.set('q', q);
      url.searchParams.delete('path');
      url.searchParams.delete('page');
      history.pushState({ search: q }, '', url);
    }
  } catch (err) {
    renderError(err.message);
  }
}

function renderSearchStatus(data) {
  statusBar.innerHTML = `
    <span>search: <span class="count-accent">"${escHtml(data.query)}"</span></span>
    <span><span class="count-accent">${data.imageCount}</span> result${data.imageCount === 1 ? '' : 's'}</span>
  `;
}

function renderSearchGrid(items) {
  if (!items.length) {
    grid.innerHTML = '<div class="empty-state">No images match your search.</div>';
    return;
  }
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  items.forEach((item, idx) => {
    frag.appendChild(makeImage({ name: item.name }, item.dir, idx));
  });
  grid.appendChild(frag);
}

let searchDebounce = null;
searchInput.addEventListener('input', () => {
  searchClear.hidden = !searchInput.value;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(searchInput.value), 300);
});
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    clearTimeout(searchDebounce);
    runSearch(searchInput.value);
  } else if (e.key === 'Escape') {
    searchInput.blur();
  }
});
searchClear.addEventListener('click', () => {
  navigate(state.path, state.page);
});

function searchForTag(tagName) {
  closeLightbox();
  closeTagsModal();
  runSearch(`tag:${tagName}`);
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
      card = makeImage(item, state.path, state.imageNames.indexOf(item.name));
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

// `dir` is the folder this image lives in (relative to the gallery root);
// `lbIndex` is this image's index into state.lbSource, used to open the
// lightbox at the right spot and let it page through the same result set
// (a folder listing or a search's results) via prev/next.
function makeImage(item, dir, lbIndex) {
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
  img.src = thumbURL(dir, item.name, 200);
  wrap.appendChild(img);

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = item.name;

  card.appendChild(wrap);
  card.appendChild(name);

  card.addEventListener('click', () => {
    openLightbox(lbIndex >= 0 ? lbIndex : 0);
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
  if (!state.lbSource.length) return;
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
  const items = state.lbSource;
  if (!items.length) return;
  const clamp = i => Math.max(0, Math.min(items.length - 1, i));
  index = clamp(index);
  state.lb.index = index;

  if (resetTransform) resetLbTransform(/*apply*/ false);

  const { dir, name } = items[index];
  lbCaption.textContent = state.search.active && dir ? `${dir}/${name}` : name;
  lbCounter.textContent = `${index + 1} / ${items.length}`;
  lbPrev.disabled = index === 0;
  lbNext.disabled = index === items.length - 1;

  lbImg.classList.add('fading');
  lbSpinner.classList.add('visible');

  const url = thumbURL(dir, name);
  const tmp = new Image();
  tmp.onload = tmp.onerror = () => {
    lbImg.src = url;
    lbImg.alt = name;
    lbImg.classList.remove('fading');
    lbSpinner.classList.remove('visible');
    applyLbTransform();
  };
  tmp.src = url;

  loadLbTags(dir, name);
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

// ── Lightbox: tag editor ─────────────────────────────────────────────────────
function tagsURL(dir, file) {
  return `/api/image-tags?${new URLSearchParams({ path: dir, file })}`;
}

async function loadLbTags(dir, name) {
  state.lb.currentDir = dir;
  state.lb.currentName = name;
  state.lb.tags = [];
  lbTagsList.innerHTML = '';
  lbTagsStatus.textContent = 'loading tags…';

  try {
    const res = await fetch(tagsURL(dir, name));
    if (!res.ok) throw new Error('failed to load');
    const data = await res.json();
    // Guard against a slow response landing after the user has already
    // moved on to a different image.
    if (state.lb.currentDir !== dir || state.lb.currentName !== name) return;
    state.lb.tags = data.tags || [];
    renderLbTags();
    lbTagsStatus.textContent = '';
  } catch {
    if (state.lb.currentDir !== dir || state.lb.currentName !== name) return;
    lbTagsStatus.textContent = 'tags unavailable';
  }
}

function renderLbTags() {
  lbTagsList.innerHTML = '';
  const frag = document.createDocumentFragment();
  state.lb.tags.forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';

    const label = document.createElement('span');
    label.className = 'tag-chip-label';
    label.textContent = tag;
    label.title = `Find all images tagged "${tag}"`;
    label.addEventListener('click', () => searchForTag(tag));

    const remove = document.createElement('button');
    remove.className = 'tag-chip-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Remove tag "${tag}"`;
    remove.addEventListener('click', () => removeLbTag(tag));

    chip.appendChild(label);
    chip.appendChild(remove);
    frag.appendChild(chip);
  });
  lbTagsList.appendChild(frag);
}

async function saveLbTags() {
  const { currentDir, currentName, tags } = state.lb;
  if (currentName === undefined) return;
  lbTagsStatus.textContent = 'saving…';
  try {
    const res = await fetch('/api/image-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentDir, file: currentName, tags }),
    });
    if (!res.ok) throw new Error('save failed');
    const data = await res.json();
    if (state.lb.currentDir !== currentDir || state.lb.currentName !== currentName) return;
    state.lb.tags = data.tags;
    renderLbTags();
    lbTagsStatus.textContent = 'saved';
    setTimeout(() => { if (lbTagsStatus.textContent === 'saved') lbTagsStatus.textContent = ''; }, 1200);
  } catch {
    lbTagsStatus.textContent = 'save failed';
  }
}

function addLbTag(raw) {
  const tag = raw.trim();
  if (!tag) return;
  if (!state.lb.tags.some(t => t.toLowerCase() === tag.toLowerCase())) {
    state.lb.tags.push(tag);
    renderLbTags();
    saveLbTags();
  }
}

function removeLbTag(tag) {
  state.lb.tags = state.lb.tags.filter(t => t !== tag);
  renderLbTags();
  saveLbTags();
}

lbTagInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    addLbTag(lbTagInput.value);
    lbTagInput.value = '';
  }
});

// ── Tags modal (browse most-common tags) ─────────────────────────────────────
async function openTagsModal() {
  tagsModal.hidden = false;
  tagsModalBody.innerHTML = '<div class="modal-loading">loading…</div>';
  try {
    const res = await fetch('/api/tags?limit=40');
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    const data = await res.json();
    renderTagsModal(data.tags);
  } catch (err) {
    tagsModalBody.innerHTML = `<div class="empty-state">⚠ ${escHtml(err.message)}</div>`;
  }
}

function closeTagsModal() {
  tagsModal.hidden = true;
}

function renderTagsModal(tags) {
  if (!tags.length) {
    tagsModalBody.innerHTML = '<div class="empty-state">No tags yet. Tag some images to see them here.</div>';
    return;
  }
  tagsModalBody.innerHTML = '';
  const cloud = document.createElement('div');
  cloud.className = 'tag-cloud';
  tags.forEach(t => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'tag-pill';
    pill.innerHTML = `<span class="tag-pill-name">${escHtml(t.name)}</span><span class="tag-pill-count">${t.count}</span>`;
    pill.addEventListener('click', () => searchForTag(t.name));
    cloud.appendChild(pill);
  });
  tagsModalBody.appendChild(cloud);
}

btnTags.addEventListener('click', openTagsModal);
tagsModalClose.addEventListener('click', closeTagsModal);
tagsModalBackdrop.addEventListener('click', closeTagsModal);

// Keyboard navigation + zoom/rotate shortcuts
document.addEventListener('keydown', e => {
  if (!tagsModal.hidden && e.key === 'Escape') { closeTagsModal(); return; }

  if (e.altKey && e.key === 'g') {
    toggleMasonry();
  }
  if (!state.lb.open) return;

  // Don't hijack typing in the tag input (or any other focused field) with
  // lightbox shortcuts — only Escape should still act (blur the field).
  const typingTarget = e.target === lbTagInput || e.target === searchInput;
  if (typingTarget) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }

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
  if (s && typeof s.search === 'string') {
    runSearch(s.search, /*pushHistory*/ false);
  } else if (s) {
    exitSearchUI();
    state.path = s.path;
    state.page = s.page;
    loadPage();
  } else {
    navigate('', 1);
  }
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
  const q = url.searchParams.get('q');
  if (q) {
    runSearch(q, /*pushHistory*/ false);
    return;
  }
  const path = url.searchParams.get('path') || '';
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  navigate(path, page);
})();
