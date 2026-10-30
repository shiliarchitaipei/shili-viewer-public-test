/**
 * Offline Viewer Core Logic (Task D03 v2.1 Candidate)
 * Pure text rendering, zero unsanitized HTML, strictly offline.
 * Implements strict allowlist, race condition protection, PDF format sanity checking,
 * branch/document state reset, isolated carousel a11y, and async token safety.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Strict allowlist of permitted published & snapshot paths
  const ALLOWED_SNAPSHOT_PATHS = new Set([
    'data/published.json',
    'data/snapshots/snapshot_rev1.json',
    'data/snapshots/snapshot_rev2.json',
    'data/snapshots/snapshot_rev3_corrupted.json'
  ]);

  // PDF.js configuration (Official Mozilla PDF.js v4.10.38 - Security Patched)
  const globalPdfjs = (typeof window !== 'undefined' && window.pdfjsLib)
    ? window.pdfjsLib
    : ((typeof pdfjsLib !== 'undefined') ? pdfjsLib : null);

  if (globalPdfjs && globalPdfjs.GlobalWorkerOptions) {
    globalPdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.mjs';
  }

  // Application State
  const state = {
    contractData: null,
    activeSnapshotPath: 'data/published.json',
    carousel: {
      items: [],
      currentIndex: 0
    },
    docViewer: {
      branchId: 'ALL',
      currentDoc: null,
      status: 'empty', // 'empty' | 'loading' | 'ready' | 'error'
      currentPage: 1,
      totalPages: 0, // 0 until confirmed by valid PDF parsing
      zoomLevel: 1.0,
      pageBaseWidth: 0,
      pageBaseHeight: 0,
      isBadPdf: false,
      pdfError: null,
      pdfDoc: null
    }
  };

  // Race condition management
  let activeSnapshotRequestId = 0;
  let activeSnapshotAbortController = null;

  let activeDocRequestId = 0;
  let activeDocAbortController = null;
  let activePageRequestId = 0;
  let activeRenderTask = null;

  // DOM Elements (Safely resolved in browser or test environments)
  const getEl = (id) => (typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null);

  const els = {
    get contractBadge() { return getEl('contract-badge'); },
    get snapshotSelector() { return getEl('snapshot-selector'); },
    get btnReloadSnapshot() { return getEl('btn-reload-snapshot'); },
    get btnRollbackRev1() { return getEl('btn-rollback-rev1'); },
    get noticeContainer() { return getEl('notice-container'); },
    get noticeTitle() { return getEl('notice-title'); },
    get noticeList() { return getEl('notice-list'); },
    get carouselSection() { return getEl('carousel-section'); },
    get carouselTrack() { return getEl('carousel-track'); },
    get carouselBtnPrev() { return getEl('carousel-btn-prev'); },
    get carouselBtnNext() { return getEl('carousel-btn-next'); },
    get carouselIndicators() { return getEl('carousel-indicators-container'); },
    get branchSelector() { return getEl('branch-selector'); },
    get docSelector() { return getEl('doc-selector'); },
    get pdfBtnPrevPage() { return getEl('pdf-btn-prev-page'); },
    get pdfBtnNextPage() { return getEl('pdf-btn-next-page'); },
    get pdfPageIndicator() { return getEl('pdf-page-indicator'); },
    get pdfBtnZoomOut() { return getEl('pdf-btn-zoom-out'); },
    get pdfBtnZoomIn() { return getEl('pdf-btn-zoom-in'); },
    get pdfBtnZoomReset() { return getEl('pdf-btn-zoom-reset'); },
    get pdfZoomIndicator() { return getEl('pdf-zoom-indicator'); },
    get pdfBtnOpenTab() { return getEl('pdf-btn-open-tab'); },
    get pdfBtnDownload() { return getEl('pdf-btn-download'); },
    get pdfDisplayArea() { return getEl('pdf-display-area'); },
    get pdfRenderSurface() { return getEl('pdf-render-surface'); },
    get newsList() { return getEl('news-list'); },
    get booksList() { return getEl('books-list'); }
  };

  // Safe DOM creation helper
  function createElement(tag, className, textContent) {
    if (typeof document === 'undefined') return { className, textContent, appendChild: () => {}, setAttribute: () => {} };
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (textContent !== undefined && textContent !== null) {
      el.textContent = textContent;
    }
    return el;
  }

  // Notice & Error Display
  function showErrorNotice(title, errors) {
    if (!els.noticeContainer) return;
    if (els.noticeTitle) els.noticeTitle.textContent = title;
    if (els.noticeList) {
      if (els.noticeList.replaceChildren) {
        els.noticeList.replaceChildren();
      } else {
        els.noticeList.innerHTML = '';
      }
      errors.forEach(err => {
        const li = createElement('li', '', err);
        els.noticeList.appendChild(li);
      });
    }
    els.noticeContainer.className = 'notice-box danger visible';
  }

  function hideNotice() {
    if (!els.noticeContainer) return;
    els.noticeContainer.className = 'notice-box danger';
    if (els.noticeList) {
      if (els.noticeList.replaceChildren) {
        els.noticeList.replaceChildren();
      } else {
        els.noticeList.innerHTML = '';
      }
    }
  }

  /**
   * Path normalizer and strict allowlist validator.
   * Rejects encoded traversal, external URLs, unknown paths BEFORE fetch.
   */
  function normalizeAndValidatePath(rawPath) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      return { ok: false, error: '路徑不得為空。' };
    }

    let decoded;
    try {
      decoded = decodeURIComponent(rawPath.trim());
    } catch (e) {
      return { ok: false, error: 'URL 編碼異常。' };
    }

    // Check for URL schemes or protocols
    if (/^[a-zA-Z]+:\/\//.test(decoded) || /^[a-zA-Z]+:/.test(decoded)) {
      return { ok: false, error: '拒絕外部或帶有通訊協定之網址。' };
    }

    // Check for directory traversal, null bytes, backslashes
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.startsWith('/') || decoded.includes('..')) {
      return { ok: false, error: '路徑包含非法字元或路徑穿越字符 (..)。' };
    }

    let normalized = decoded.replace(/^\.\//, '');

    // Strict allowlist matching
    if (!ALLOWED_SNAPSHOT_PATHS.has(normalized)) {
      return {
        ok: false,
        error: `【未授權或未知資料路徑】僅允許載入白名單內之 published.json 與指定快照。已拒絕路徑: "${normalized}"`
      };
    }

    return { ok: true, path: normalized };
  }

  // 1. Data Loader with Strict Allowlist & Race Protection
  async function loadData(targetPath) {
    hideNotice();

    const check = normalizeAndValidatePath(targetPath);
    if (!check.ok) {
      showErrorNotice('存取拒絕 (Path Access Rejected)', [check.error]);
      return false;
    }

    const safePath = check.path;

    if (activeSnapshotAbortController) {
      activeSnapshotAbortController.abort();
    }
    activeSnapshotAbortController = new AbortController();
    const requestId = ++activeSnapshotRequestId;

    // Invalidate any in-flight document requests when loading new snapshot
    if (activeDocAbortController) {
      activeDocAbortController.abort();
      activeDocAbortController = null;
    }
    ++activeDocRequestId;
    ++activePageRequestId;

    try {
      const response = await fetch(safePath, { signal: activeSnapshotAbortController.signal });
      if (!response.ok) {
        throw new Error(`無法讀取檔案: HTTP ${response.status} (${safePath})`);
      }
      const data = await response.json();

      if (requestId !== activeSnapshotRequestId) {
        return false;
      }

      const validator = (typeof ContractValidator !== 'undefined') ? ContractValidator : (typeof require !== 'undefined' ? require('./validator.js') : null);
      if (!validator) {
        throw new Error('找不到 ContractValidator 模組。');
      }

      const validation = validator.validateContract(data);
      if (!validation.valid) {
        // Preserves stable view on invalid snapshot
        showErrorNotice(`快照契約驗證失敗 (版本: ${data.schemaVersion || '未知'})`, validation.errors);
        return false;
      }

      // Success: update state and view
      state.contractData = data;
      state.activeSnapshotPath = safePath;
      if (els.contractBadge) {
        els.contractBadge.textContent = `Schema ${data.schemaVersion} (Rev ${data.revision}) - 驗證通過`;
        els.contractBadge.style.background = '#e8f8f5';
        els.contractBadge.style.color = '#117a65';
      }

      renderAll();
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      if (requestId === activeSnapshotRequestId) {
        showErrorNotice('檔案讀取或解析失敗', [err.message]);
      }
      return false;
    }
  }

  // 2. Carousel Logic (with a11y & Focus Isolation)
  function setupCarousel() {
    const rawItems = state.contractData?.carousel || [];
    state.carousel.items = rawItems
      .filter(item => item.enabled === true)
      .sort((a, b) => a.order - b.order);
    state.carousel.currentIndex = 0;
    renderCarousel();
  }

  function renderCarousel() {
    const track = els.carouselTrack;
    const indicators = els.carouselIndicators;
    if (!track || !indicators) return;

    if (track.replaceChildren) {
      track.replaceChildren();
      indicators.replaceChildren();
    } else {
      track.innerHTML = '';
      indicators.innerHTML = '';
    }

    const items = state.carousel.items;

    if (items.length === 0) {
      const emptyCard = createElement('div', 'degradation-card');
      const h4 = createElement('h4', '', '目前尚無啟用的活動輪播項目');
      const p = createElement('p', '', '所有橫幅皆已停用或資料清單為空。');
      emptyCard.appendChild(h4);
      emptyCard.appendChild(p);
      track.appendChild(emptyCard);
      if (els.carouselBtnPrev) els.carouselBtnPrev.disabled = true;
      if (els.carouselBtnNext) els.carouselBtnNext.disabled = true;
      return;
    }

    if (els.carouselBtnPrev) els.carouselBtnPrev.disabled = false;
    if (els.carouselBtnNext) els.carouselBtnNext.disabled = false;

    items.forEach((item, idx) => {
      const isCurrent = idx === state.carousel.currentIndex;
      const slide = createElement('div', 'carousel-slide');
      slide.id = `slide-${item.id}`;
      slide.setAttribute('role', 'tabpanel');
      slide.setAttribute('aria-roledescription', 'slide');
      slide.setAttribute('aria-label', `第 ${idx + 1} 張，共 ${items.length} 張: ${item.alt}`);

      if (isCurrent) {
        slide.classList.add('active');
        slide.setAttribute('aria-hidden', 'false');
        slide.removeAttribute('inert');
      } else {
        slide.classList.remove('active');
        slide.setAttribute('aria-hidden', 'true');
        slide.setAttribute('inert', '');
      }

      if (typeof document !== 'undefined') {
        const img = document.createElement('img');
        img.className = 'carousel-image';
        img.src = item.imagePath;
        img.alt = item.alt;
        img.loading = 'lazy';

        img.onerror = function () {
          if (slide.replaceChildren) slide.replaceChildren();
          else slide.innerHTML = '';
          const fallback = createElement('div', 'image-fallback');
          const fbTitle = createElement('strong', '', '【圖片無法顯示】');
          const fbAlt = createElement('p', '', `替代說明 (alt): ${item.alt}`);
          const fbPath = createElement('small', '', `相對路徑: ${item.imagePath}`);
          fallback.appendChild(fbTitle);
          fallback.appendChild(fbAlt);
          fallback.appendChild(fbPath);
          slide.appendChild(fallback);
        };

        slide.appendChild(img);
      }

      const caption = createElement('div', 'carousel-caption');
      if (item.title && item.title.trim()) {
        const titleEl = createElement('h3', '', item.title);
        caption.appendChild(titleEl);
      }

      if (item.targetUrl) {
        const link = createElement('a', '', '了解更多 →');
        link.href = item.targetUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        if (!isCurrent) link.setAttribute('tabindex', '-1');
        caption.appendChild(link);
      }

      slide.appendChild(caption);
      track.appendChild(slide);

      const dot = createElement('button', 'indicator-dot');
      dot.setAttribute('type', 'button');
      dot.setAttribute('role', 'tab');
      dot.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
      dot.setAttribute('aria-label', `切換至第 ${idx + 1} 張輪播圖`);
      if (isCurrent) dot.classList.add('active');
      if (dot.addEventListener) {
        dot.addEventListener('click', () => {
          goToSlide(idx);
        });
      }
      indicators.appendChild(dot);
    });
  }

  function goToSlide(newIndex) {
    const total = state.carousel.items.length;
    if (total === 0) return;
    if (newIndex < 0) newIndex = total - 1;
    if (newIndex >= total) newIndex = 0;
    state.carousel.currentIndex = newIndex;

    if (!els.carouselTrack || !els.carouselIndicators) return;

    const slides = els.carouselTrack.querySelectorAll('.carousel-slide');
    slides.forEach((s, idx) => {
      const isCur = idx === newIndex;
      const links = s.querySelectorAll('a, button');
      if (isCur) {
        s.classList.add('active');
        s.setAttribute('aria-hidden', 'false');
        s.removeAttribute('inert');
        links.forEach(l => l.removeAttribute('tabindex'));
      } else {
        s.classList.remove('active');
        s.setAttribute('aria-hidden', 'true');
        s.setAttribute('inert', '');
        links.forEach(l => l.setAttribute('tabindex', '-1'));
      }
    });

    const dots = els.carouselIndicators.querySelectorAll('.indicator-dot');
    dots.forEach((d, idx) => {
      const isCur = idx === newIndex;
      if (isCur) {
        d.classList.add('active');
        d.setAttribute('aria-selected', 'true');
      } else {
        d.classList.remove('active');
        d.setAttribute('aria-selected', 'false');
      }
    });
  }

  // 3. Document / PDF Viewer Logic
  function resetSurfaceBox(surface) {
    if (!surface || !surface.style) return;
    surface.style.width = '';
    surface.style.height = '';
    surface.style.maxWidth = '100%';
    surface.style.transform = 'none';
  }

  function getAvailableDisplayWidth() {
    const container = els.pdfDisplayArea;
    if (!container) return 0;
    const clientW = Number(container.clientWidth) || 0;
    if (clientW <= 0) return 0;
    let padLeft = 0;
    let padRight = 0;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const cs = window.getComputedStyle(container);
        padLeft = parseFloat(cs && cs.paddingLeft) || 0;
        padRight = parseFloat(cs && cs.paddingRight) || 0;
      } catch (_) {}
    } else if (container.style) {
      padLeft = parseFloat(container.style.paddingLeft) || 0;
      padRight = parseFloat(container.style.paddingRight) || 0;
    }
    return Math.max(1, clientW - padLeft - padRight);
  }

  function computePdfDisplayDimensions(baseWidth, baseHeight, zoomLevel, availableWidth) {
    const bw = Math.max(1, Number(baseWidth) || 612);
    const bh = Math.max(1, Number(baseHeight) || 792);
    const zoom = Math.max(0.5, Math.min(2.0, Number(zoomLevel) || 1.0));
    const availW = Number(availableWidth) > 0 ? Number(availableWidth) : 0;
    const fitWidth = availW > 0 ? Math.min(bw, availW) : bw;
    const fitScale = fitWidth / bw;
    const cssWidth = Math.round(bw * fitScale * zoom * 100) / 100;
    const cssHeight = Math.round(bh * fitScale * zoom * 100) / 100;
    return {
      baseWidth: bw,
      baseHeight: bh,
      fitWidth: Math.round(fitWidth * 100) / 100,
      fitHeight: Math.round(bh * fitScale * 100) / 100,
      zoomLevel: zoom,
      cssWidth: cssWidth,
      cssHeight: cssHeight,
      aspectRatio: bw / bh,
      cssAspectRatio: cssWidth / cssHeight
    };
  }

  function setupDocViewer() {
    state.docViewer.status = 'empty';
    state.docViewer.currentPage = 1;
    state.docViewer.totalPages = 0;
    state.docViewer.zoomLevel = 1.0;
    state.docViewer.pageBaseWidth = 0;
    state.docViewer.pageBaseHeight = 0;
    state.docViewer.isBadPdf = false;
    state.docViewer.pdfError = null;

    populateDocSelector();
  }

  function getFilteredDocuments() {
    const rawDocs = state.contractData?.documents || [];
    const bId = state.docViewer.branchId;
    if (bId === 'ALL') return rawDocs;
    return rawDocs.filter(doc => doc.branchId === bId);
  }

  function populateDocSelector() {
    // Invalidate in-flight document requests immediately
    if (activeDocAbortController) {
      activeDocAbortController.abort();
      activeDocAbortController = null;
    }
    ++activeDocRequestId;
    ++activePageRequestId;

    const selector = els.docSelector;
    if (selector) {
      if (selector.replaceChildren) selector.replaceChildren();
      else selector.innerHTML = '';
    }

    const filtered = getFilteredDocuments();

    if (filtered.length === 0) {
      if (selector) {
        const opt = createElement('option', '', '無可用文件');
        opt.value = '';
        selector.appendChild(opt);
      }
      state.docViewer.currentDoc = null;
      state.docViewer.status = 'empty';
      state.docViewer.currentPage = 1;
      state.docViewer.totalPages = 0;
      state.docViewer.zoomLevel = 1.0;
      state.docViewer.pageBaseWidth = 0;
      state.docViewer.pageBaseHeight = 0;
      state.docViewer.isBadPdf = false;
      state.docViewer.pdfError = null;
      renderDocDisplay();
      return;
    }

    if (selector) {
      filtered.forEach(doc => {
        const opt = createElement('option', '', `[${doc.branchId}] ${doc.title} (v${doc.version})`);
        opt.value = doc.id;
        selector.appendChild(opt);
      });
    }

    // Reset page, totalPages, and zoom to clean initial loading state on document change
    state.docViewer.currentDoc = filtered[0];
    state.docViewer.status = 'loading';
    state.docViewer.currentPage = 1;
    state.docViewer.totalPages = 0;
    state.docViewer.zoomLevel = 1.0;
    state.docViewer.pageBaseWidth = 0;
    state.docViewer.pageBaseHeight = 0;
    state.docViewer.isBadPdf = false;
    state.docViewer.pdfError = null;

    renderDocDisplay();
  }

  async function renderPdfPage(pageNum, docGen) {
    const targetDocGen = (docGen !== undefined && docGen !== null) ? docGen : activeDocRequestId;
    const pageGen = ++activePageRequestId;
    const surface = els.pdfRenderSurface;
    const pdfDoc = state.docViewer.pdfDoc;
    const currentDoc = state.docViewer.currentDoc;
    const expectedDocId = currentDoc ? currentDoc.id : null;
    if (!surface || !pdfDoc || !currentDoc) return false;

    if (activeRenderTask) {
      try {
        activeRenderTask.cancel();
      } catch (_) {}
      activeRenderTask = null;
    }

    const maxPages = Math.max(1, state.docViewer.totalPages || pdfDoc.numPages || 1);
    pageNum = Math.max(1, Math.min(pageNum, maxPages));
    state.docViewer.currentPage = pageNum;

    function isCurrentRequest() {
      return (
        targetDocGen === activeDocRequestId &&
        pageGen === activePageRequestId &&
        state.docViewer.pdfDoc === pdfDoc &&
        Boolean(state.docViewer.currentDoc) &&
        state.docViewer.currentDoc.id === expectedDocId
      );
    }

    let renderTask = null;
    try {
      const page = await pdfDoc.getPage(pageNum);
      if (!isCurrentRequest()) return false;

      if (surface.replaceChildren) surface.replaceChildren();
      else surface.innerHTML = '';

      if (typeof document !== 'undefined' && document.createElement) {
        const canvas = createElement('canvas', 'pdf-canvas');
        canvas.id = 'pdf-canvas';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `PDF 頁面 - 第 ${pageNum} 頁 (共 ${maxPages} 頁)`);
        surface.appendChild(canvas);

        const ctx = (canvas && typeof canvas.getContext === 'function') ? canvas.getContext('2d') : {};
        const pixelRatio = (typeof window !== 'undefined' && window.devicePixelRatio) ? Math.min(window.devicePixelRatio, 2) : 1;
        const displayViewport = (page && typeof page.getViewport === 'function')
          ? page.getViewport({ scale: 1.0 })
          : { width: 612, height: 792 };
        const renderViewport = (page && typeof page.getViewport === 'function')
          ? page.getViewport({ scale: 1.0 * pixelRatio })
          : { width: 612 * pixelRatio, height: 792 * pixelRatio };

        state.docViewer.pageBaseWidth = Math.max(1, Number(displayViewport.width) || 612);
        state.docViewer.pageBaseHeight = Math.max(1, Number(displayViewport.height) || 792);

        canvas.width = Math.floor(renderViewport.width);
        canvas.height = Math.floor(renderViewport.height);
        applyZoom();

        if (page && typeof page.render === 'function') {
          const renderContext = {
            canvasContext: ctx,
            viewport: renderViewport
          };

          renderTask = page.render(renderContext);
          activeRenderTask = renderTask;
          if (renderTask && renderTask.promise) {
            await renderTask.promise;
          }
          if (activeRenderTask === renderTask) {
            activeRenderTask = null;
          }
        }
      }

      // Continuation check after renderTask.promise
      if (!isCurrentRequest()) return false;

      state.docViewer.status = 'ready';
      state.docViewer.isBadPdf = false;
      state.docViewer.pdfError = null;
      state.docViewer.totalPages = maxPages;

      applyZoom();
      updateDocToolbar(true);
      return true;
    } catch (err) {
      if (renderTask && activeRenderTask === renderTask) {
        activeRenderTask = null;
      }
      // Distinguish cancellation from real getPage / render failure
      if (
        err &&
        (err.name === 'RenderingCancelledException' ||
         err.name === 'AbortError' ||
         /cancelled|canceled/i.test(String(err.message || '')))
      ) {
        return false;
      }
      // Ignore stale errors from superseded documents or pages
      if (!isCurrentRequest()) {
        return false;
      }
      // Genuine getPage / render error on active document: degrade to error state
      const errMsg = (err && err.message) ? err.message : String(err || 'PDF 頁面解析或繪製失敗');
      state.docViewer.status = 'error';
      state.docViewer.isBadPdf = true;
      state.docViewer.totalPages = 0;
      state.docViewer.pdfError = `頁面渲染失敗 (第 ${pageNum} 頁): ${errMsg}`;
      renderBadPdfDegradation(currentDoc, state.docViewer.pdfError, '【PDF 頁面渲染或解析失敗】');
      return false;
    }
  }

  async function renderDocDisplay() {
    // RUNTIME FIX: Always abort pending document fetch and increment generation token
    // BEFORE checking if doc is null, ensuring delayed responses can never overwrite empty branch!
    if (activeDocAbortController) {
      activeDocAbortController.abort();
      activeDocAbortController = null;
    }
    if (activeRenderTask) {
      try { activeRenderTask.cancel(); } catch (_) {}
      activeRenderTask = null;
    }
    const currentDocGeneration = ++activeDocRequestId;
    ++activePageRequestId;

    if (state.docViewer.pdfDoc && state.docViewer.pdfDoc.destroy) {
      try { state.docViewer.pdfDoc.destroy(); } catch (_) {}
      state.docViewer.pdfDoc = null;
    }

    const doc = state.docViewer.currentDoc;
    const surface = els.pdfRenderSurface;
    if (surface) {
      if (surface.replaceChildren) surface.replaceChildren();
      else surface.innerHTML = '';
      resetSurfaceBox(surface);
    }

    if (!doc) {
      state.docViewer.status = 'empty';
      state.docViewer.totalPages = 0;
      state.docViewer.currentPage = 1;
      state.docViewer.pageBaseWidth = 0;
      state.docViewer.pageBaseHeight = 0;
      state.docViewer.isBadPdf = false;
      state.docViewer.pdfError = null;
      if (surface) {
        const card = createElement('div', 'degradation-card');
        card.appendChild(createElement('h4', '', '目前此分班尚無任何可檢視之文件'));
        card.appendChild(createElement('p', '', '請從上方分班選單切換至其他分班，或檢視全部文件。'));
        surface.appendChild(card);
      }
      updateDocToolbar(false);
      return;
    }

    // Enter loading state: do not expose stale page count or claim format is valid
    state.docViewer.status = 'loading';
    state.docViewer.totalPages = 0;
    state.docViewer.pageBaseWidth = 0;
    state.docViewer.pageBaseHeight = 0;
    state.docViewer.isBadPdf = false;
    state.docViewer.pdfError = null;
    updateDocToolbar(true);

    activeDocAbortController = new AbortController();
    const expectedDocId = doc.id;

    if (surface) {
      const loadingCard = createElement('div', 'degradation-card');
      loadingCard.appendChild(createElement('h4', '', `檢驗文件格式中: ${doc.title}`));
      loadingCard.appendChild(createElement('p', '', '執行二進位標頭/結尾健全度檢查中...'));
      surface.appendChild(loadingCard);
    }

    try {
      const response = await fetch(doc.filePath, { signal: activeDocAbortController.signal });
      if (!response.ok) {
        throw new Error(`無法載入檔案: HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();

      // Async continuation check 1: check generation token and current document identity
      if (currentDocGeneration !== activeDocRequestId) return;
      if (!state.docViewer.currentDoc || state.docViewer.currentDoc.id !== expectedDocId) return;

      // Binary format sanity check via PdfInspector
      let inspector = (typeof PdfInspector !== 'undefined') ? PdfInspector : (typeof require !== 'undefined' ? require('./pdf_inspector.js') : null);
      let inspection = { valid: false, estimatedPages: 0, error: '缺少 PdfInspector 模組' };
      if (inspector) {
        inspection = inspector.inspectPdf(buffer);
      }

      // Async continuation check 2: re-check after inspection
      if (currentDocGeneration !== activeDocRequestId) return;
      if (!state.docViewer.currentDoc || state.docViewer.currentDoc.id !== expectedDocId) return;

      if (!inspection.valid) {
        state.docViewer.status = 'error';
        state.docViewer.isBadPdf = true;
        state.docViewer.totalPages = 0;
        state.docViewer.pdfError = inspection.error;
        renderBadPdfDegradation(doc, inspection.error);
        return;
      }

      // Resolve Mozilla PDF.js engine
      let pdfLib = (typeof window !== 'undefined' && window.pdfjsLib)
        ? window.pdfjsLib
        : ((typeof pdfjsLib !== 'undefined') ? pdfjsLib : null);

      if (!pdfLib && typeof window !== 'undefined' && window.__pdfjsReadyPromise) {
        try {
          pdfLib = await window.__pdfjsReadyPromise;
        } catch (_) {
          pdfLib = null;
        }
        if (currentDocGeneration !== activeDocRequestId) return;
        if (!state.docViewer.currentDoc || state.docViewer.currentDoc.id !== expectedDocId) return;
      }

      if (pdfLib) {
        try {
          const loadingTask = pdfLib.getDocument({
            data: new Uint8Array(buffer),
            cMapUrl: 'vendor/pdfjs/cmaps/',
            cMapPacked: true,
            standardFontDataUrl: 'vendor/pdfjs/standard_fonts/'
          });
          const loadedPdf = await loadingTask.promise;

          if (currentDocGeneration !== activeDocRequestId) {
            if (loadedPdf && loadedPdf.destroy) loadedPdf.destroy();
            return;
          }
          if (!state.docViewer.currentDoc || state.docViewer.currentDoc.id !== expectedDocId) {
            if (loadedPdf && loadedPdf.destroy) loadedPdf.destroy();
            return;
          }

          if (!loadedPdf || !Number.isInteger(loadedPdf.numPages) || loadedPdf.numPages < 1) {
            if (loadedPdf && loadedPdf.destroy) loadedPdf.destroy();
            throw new Error('PDF 文件頁數無效或無可讀取頁面');
          }

          state.docViewer.pdfDoc = loadedPdf;
          state.docViewer.totalPages = loadedPdf.numPages;
          state.docViewer.isBadPdf = false;
          state.docViewer.pdfError = null;

          await renderPdfPage(state.docViewer.currentPage, currentDocGeneration);
          return;
        } catch (pdfErr) {
          if (currentDocGeneration !== activeDocRequestId) return;
          if (!state.docViewer.currentDoc || state.docViewer.currentDoc.id !== expectedDocId) return;
          state.docViewer.status = 'error';
          state.docViewer.isBadPdf = true;
          state.docViewer.totalPages = 0;
          state.docViewer.pdfError = pdfErr.message || 'PDF 解析錯誤';
          renderBadPdfDegradation(doc, state.docViewer.pdfError);
          return;
        }
      }

      // Browser environment missing PDF.js engine: report genuine engine missing error
      if (typeof window !== 'undefined' || state.docViewer.requirePdfEngine) {
        const engineErr = (typeof window !== 'undefined' && window.__pdfjsLoadError && window.__pdfjsLoadError.message)
          ? `PDF 渲染引擎未載入 (${window.__pdfjsLoadError.message})`
          : 'PDF 渲染引擎 (PDF.js) 未載入，無法執行頁面解析與 Canvas 渲染';
        state.docViewer.status = 'error';
        state.docViewer.isBadPdf = true;
        state.docViewer.totalPages = 0;
        state.docViewer.pdfError = engineErr;
        renderBadPdfDegradation(doc, engineErr, '【PDF 渲染引擎未載入】');
        return;
      }

      // Headless unit test without window or pdfjsLib: complete sanity check without claiming browser simulation
      state.docViewer.status = 'ready';
      state.docViewer.isBadPdf = false;
      state.docViewer.pdfError = null;
      state.docViewer.totalPages = Math.max(1, inspection.estimatedPages || 1);

      if (surface) {
        if (surface.replaceChildren) surface.replaceChildren();
        else surface.innerHTML = '';
        if (typeof document !== 'undefined') {
          const fallbackText = createElement('div', 'degradation-card');
          fallbackText.appendChild(createElement('h4', '', `【PDF 渲染引擎未載入】(${doc.title})`));
          fallbackText.appendChild(createElement('p', '', '未偵測到 PDF.js 渲染引擎，僅完成二進位標頭健全度檢查。'));
          surface.appendChild(fallbackText);
        }
      }

      applyZoom();
      updateDocToolbar(true);

    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // RUNTIME FIX: Verify generation token AND current doc before rendering degradation
      if (currentDocGeneration === activeDocRequestId && state.docViewer.currentDoc && state.docViewer.currentDoc.id === expectedDocId) {
        state.docViewer.status = 'error';
        state.docViewer.isBadPdf = true;
        state.docViewer.totalPages = 0;
        state.docViewer.pdfError = err.message;
        renderBadPdfDegradation(doc, err.message);
      }
    }
  }

  function renderBadPdfDegradation(doc, errorMsg, customTitle) {
    state.docViewer.status = 'error';
    state.docViewer.isBadPdf = true;
    state.docViewer.totalPages = 0;
    state.docViewer.pageBaseWidth = 0;
    state.docViewer.pageBaseHeight = 0;
    if (errorMsg) {
      state.docViewer.pdfError = errorMsg;
    }

    const surface = els.pdfRenderSurface;
    if (surface) {
      if (surface.replaceChildren) surface.replaceChildren();
      else surface.innerHTML = '';
      resetSurfaceBox(surface);

      const card = createElement('div', 'degradation-card');
      card.style.borderColor = '#e74c3c';
      const headingText = customTitle || '【文件二進位格式異常或損毀 (真實偵測)】';
      const h4 = createElement('h4', '', headingText);
      h4.style.color = '#c0392b';
      const p1 = createElement('p', '', `文件名稱: ${doc ? doc.title : '未知文件'}`);
      const p2 = createElement('p', '', `錯誤或檢查結果: ${errorMsg || '標頭格式不符或遺失 %%EOF 結束標記'}`);
      const p3 = createElement('p', '', '友善降級處理：您仍可點擊上方「下載 PDF」嘗試取得原始檔案進行檔案鑑識。');
      card.appendChild(h4);
      card.appendChild(p1);
      card.appendChild(p2);
      card.appendChild(p3);
      surface.appendChild(card);
    }
    updateDocToolbar(true);
  }

  function updateDocToolbar(hasDoc) {
    const doc = state.docViewer.currentDoc;
    // 1. Empty state: safeguard against null doc, false hasDoc, or explicit empty status
    if (!hasDoc || !doc || state.docViewer.status === 'empty') {
      if (els.pdfBtnPrevPage) els.pdfBtnPrevPage.disabled = true;
      if (els.pdfBtnNextPage) els.pdfBtnNextPage.disabled = true;
      if (els.pdfPageIndicator) els.pdfPageIndicator.textContent = '無文件';
      if (els.pdfBtnZoomIn) els.pdfBtnZoomIn.disabled = true;
      if (els.pdfBtnZoomOut) els.pdfBtnZoomOut.disabled = true;
      if (els.pdfBtnZoomReset) els.pdfBtnZoomReset.disabled = true;
      if (els.pdfZoomIndicator) els.pdfZoomIndicator.textContent = '100%';
      if (els.pdfBtnOpenTab) els.pdfBtnOpenTab.disabled = true;
      if (els.pdfBtnDownload) {
        els.pdfBtnDownload.removeAttribute('href');
        els.pdfBtnDownload.style.pointerEvents = 'none';
        els.pdfBtnDownload.style.opacity = '0.5';
      }
      return;
    }

    // Keep raw file download / forensics entry and open-tab enabled when a doc item is selected
    if (els.pdfBtnOpenTab) els.pdfBtnOpenTab.disabled = false;
    if (els.pdfBtnDownload) {
      els.pdfBtnDownload.href = doc.filePath;
      els.pdfBtnDownload.setAttribute('download', doc.filePath.split('/').pop());
      els.pdfBtnDownload.style.pointerEvents = 'auto';
      els.pdfBtnDownload.style.opacity = '1';
    }
    if (els.pdfZoomIndicator) {
      els.pdfZoomIndicator.textContent = `${Math.round(state.docViewer.zoomLevel * 100)}%`;
    }

    // 2. Error / Corrupted / Unreadable state: never show stale totalPages or "格式健全"
    if (state.docViewer.isBadPdf || state.docViewer.status === 'error') {
      if (els.pdfPageIndicator) {
        els.pdfPageIndicator.textContent = '文件損毀或無法讀取 (無可確認頁數)';
      }
      if (els.pdfBtnPrevPage) els.pdfBtnPrevPage.disabled = true;
      if (els.pdfBtnNextPage) els.pdfBtnNextPage.disabled = true;
      if (els.pdfBtnZoomIn) els.pdfBtnZoomIn.disabled = true;
      if (els.pdfBtnZoomOut) els.pdfBtnZoomOut.disabled = true;
      if (els.pdfBtnZoomReset) els.pdfBtnZoomReset.disabled = true;
      return;
    }

    // 3. Loading state: before page count or render is confirmed
    if (state.docViewer.status === 'loading' || state.docViewer.totalPages < 1) {
      if (els.pdfPageIndicator) {
        els.pdfPageIndicator.textContent = '載入與檢驗中 (頁數待確認)...';
      }
      if (els.pdfBtnPrevPage) els.pdfBtnPrevPage.disabled = true;
      if (els.pdfBtnNextPage) els.pdfBtnNextPage.disabled = true;
      if (els.pdfBtnZoomIn) els.pdfBtnZoomIn.disabled = true;
      if (els.pdfBtnZoomOut) els.pdfBtnZoomOut.disabled = true;
      if (els.pdfBtnZoomReset) els.pdfBtnZoomReset.disabled = true;
      return;
    }

    // 4. Ready state: confirmed valid document and page count
    const page = state.docViewer.currentPage;
    const total = state.docViewer.totalPages;

    if (els.pdfPageIndicator) {
      els.pdfPageIndicator.textContent = `第 ${page} 頁 / 約 ${total} 頁 (格式健全)`;
    }
    if (els.pdfBtnPrevPage) els.pdfBtnPrevPage.disabled = page <= 1;
    if (els.pdfBtnNextPage) els.pdfBtnNextPage.disabled = page >= total;

    if (els.pdfBtnZoomIn) els.pdfBtnZoomIn.disabled = state.docViewer.zoomLevel >= 2.0;
    if (els.pdfBtnZoomOut) els.pdfBtnZoomOut.disabled = state.docViewer.zoomLevel <= 0.5;
    if (els.pdfBtnZoomReset) els.pdfBtnZoomReset.disabled = state.docViewer.zoomLevel === 1.0;
  }

  function applyZoom() {
    const surface = els.pdfRenderSurface;
    const zoom = state.docViewer.zoomLevel || 1.0;
    if (els.pdfZoomIndicator) {
      els.pdfZoomIndicator.textContent = `${Math.round(zoom * 100)}%`;
    }
    if (!surface) return null;

    let canvas = null;
    if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
      const byId = document.getElementById('pdf-canvas');
      if (byId && byId.parentNode === surface) {
        canvas = byId;
      }
    }
    if (!canvas && typeof surface.querySelector === 'function') {
      const queried = surface.querySelector('#pdf-canvas, .pdf-canvas');
      if (queried && (!queried.parentNode || queried.parentNode === surface)) {
        canvas = queried;
      }
    }
    if (!canvas && surface.children && typeof surface.children.length === 'number') {
      for (let i = 0; i < surface.children.length; i++) {
        const child = typeof surface.children.item === 'function'
          ? surface.children.item(i)
          : surface.children[i];
        if (
          child &&
          (child.id === 'pdf-canvas' || child.className === 'pdf-canvas') &&
          (!child.parentNode || child.parentNode === surface)
        ) {
          canvas = child;
          break;
        }
      }
    }

    if (canvas && state.docViewer.pageBaseWidth > 0 && state.docViewer.pageBaseHeight > 0) {
      const availW = getAvailableDisplayWidth();
      const dims = computePdfDisplayDimensions(
        state.docViewer.pageBaseWidth,
        state.docViewer.pageBaseHeight,
        zoom,
        availW
      );
      if (canvas.style) {
        canvas.style.width = `${dims.cssWidth}px`;
        canvas.style.height = `${dims.cssHeight}px`;
        canvas.style.maxWidth = 'none';
        canvas.style.aspectRatio = `${dims.baseWidth} / ${dims.baseHeight}`;
      }
      if (surface.style) {
        surface.style.width = `${dims.cssWidth}px`;
        surface.style.height = `${dims.cssHeight}px`;
        surface.style.maxWidth = 'none';
        surface.style.transform = 'none';
      }
      return dims;
    }

    if (surface.style) {
      surface.style.transform = `scale(${zoom})`;
    }
    return null;
  }

  // 4. News & Books Section
  function renderNewsAndBooks() {
    const newsList = els.newsList;
    if (newsList) {
      if (newsList.replaceChildren) newsList.replaceChildren();
      else newsList.innerHTML = '';
      const newsItems = state.contractData?.news || [];
      if (newsItems.length === 0) {
        newsList.appendChild(createElement('li', 'info-list-item', '目前無最新消息。'));
      } else {
        newsItems.forEach(n => {
          const li = createElement('li', 'info-list-item');
          const title = createElement('div', 'info-list-title', n.title);
          const body = createElement('div', 'info-list-desc', n.body);
          li.appendChild(title);
          li.appendChild(body);
          newsList.appendChild(li);
        });
      }
    }

    const booksList = els.booksList;
    if (booksList) {
      if (booksList.replaceChildren) booksList.replaceChildren();
      else booksList.innerHTML = '';
      const bookItems = state.contractData?.books || [];
      if (bookItems.length === 0) {
        booksList.appendChild(createElement('li', 'info-list-item', '目前無推薦書目。'));
      } else {
        bookItems.forEach(b => {
          const li = createElement('li', 'info-list-item');
          const title = createElement('div', 'info-list-title', b.title);
          li.appendChild(title);
          if (b.purchaseUrl) {
            const link = createElement('a', 'external-link', `購書連結: ${b.purchaseUrl}`);
            link.href = b.purchaseUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            li.appendChild(link);
          }
          booksList.appendChild(li);
        });
      }
    }
  }

  function renderAll() {
    setupCarousel();
    setupDocViewer();
    renderNewsAndBooks();
  }

  // Event Listeners Registration
  function registerEvents() {
    if (els.carouselBtnPrev) {
      els.carouselBtnPrev.addEventListener('click', () => {
        goToSlide(state.carousel.currentIndex - 1);
      });
    }

    if (els.carouselBtnNext) {
      els.carouselBtnNext.addEventListener('click', () => {
        goToSlide(state.carousel.currentIndex + 1);
      });
    }

    // Keyboard handling strictly within #carousel-section
    if (els.carouselSection) {
      els.carouselSection.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          goToSlide(state.carousel.currentIndex - 1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          goToSlide(state.carousel.currentIndex + 1);
        }
      });
    }

    if (els.branchSelector) {
      els.branchSelector.addEventListener('change', (e) => {
        state.docViewer.branchId = e.target.value;
        state.docViewer.status = 'loading';
        state.docViewer.currentPage = 1;
        state.docViewer.totalPages = 0;
        state.docViewer.zoomLevel = 1.0;
        state.docViewer.pageBaseWidth = 0;
        state.docViewer.pageBaseHeight = 0;
        state.docViewer.isBadPdf = false;
        state.docViewer.pdfError = null;
        populateDocSelector();
      });
    }

    if (els.docSelector) {
      els.docSelector.addEventListener('change', (e) => {
        const selectedId = e.target.value;
        const docs = getFilteredDocuments();
        state.docViewer.currentDoc = docs.find(d => d.id === selectedId) || null;
        state.docViewer.status = state.docViewer.currentDoc ? 'loading' : 'empty';
        state.docViewer.currentPage = 1;
        state.docViewer.totalPages = 0;
        state.docViewer.zoomLevel = 1.0;
        state.docViewer.pageBaseWidth = 0;
        state.docViewer.pageBaseHeight = 0;
        state.docViewer.isBadPdf = false;
        state.docViewer.pdfError = null;
        renderDocDisplay();
      });
    }

    if (els.pdfBtnPrevPage) {
      els.pdfBtnPrevPage.addEventListener('click', () => {
        if (state.docViewer.isBadPdf || state.docViewer.status !== 'ready') return;
        if (state.docViewer.currentPage > 1) {
          state.docViewer.currentPage -= 1;
          if (state.docViewer.pdfDoc) {
            renderPdfPage(state.docViewer.currentPage, activeDocRequestId);
          } else {
            renderDocDisplay();
          }
        }
      });
    }

    if (els.pdfBtnNextPage) {
      els.pdfBtnNextPage.addEventListener('click', () => {
        if (state.docViewer.isBadPdf || state.docViewer.status !== 'ready') return;
        if (state.docViewer.currentPage < state.docViewer.totalPages) {
          state.docViewer.currentPage += 1;
          if (state.docViewer.pdfDoc) {
            renderPdfPage(state.docViewer.currentPage, activeDocRequestId);
          } else {
            renderDocDisplay();
          }
        }
      });
    }

    if (els.pdfBtnZoomIn) {
      els.pdfBtnZoomIn.addEventListener('click', () => {
        if (state.docViewer.isBadPdf || state.docViewer.status !== 'ready') return;
        if (state.docViewer.zoomLevel < 2.0) {
          state.docViewer.zoomLevel = Math.min(2.0, state.docViewer.zoomLevel + 0.25);
          applyZoom();
          updateDocToolbar(!!state.docViewer.currentDoc);
        }
      });
    }

    if (els.pdfBtnZoomOut) {
      els.pdfBtnZoomOut.addEventListener('click', () => {
        if (state.docViewer.isBadPdf || state.docViewer.status !== 'ready') return;
        if (state.docViewer.zoomLevel > 0.5) {
          state.docViewer.zoomLevel = Math.max(0.5, state.docViewer.zoomLevel - 0.25);
          applyZoom();
          updateDocToolbar(!!state.docViewer.currentDoc);
        }
      });
    }

    if (els.pdfBtnZoomReset) {
      els.pdfBtnZoomReset.addEventListener('click', () => {
        if (state.docViewer.isBadPdf || state.docViewer.status !== 'ready') return;
        state.docViewer.zoomLevel = 1.0;
        applyZoom();
        updateDocToolbar(!!state.docViewer.currentDoc);
      });
    }

    if (els.pdfBtnOpenTab) {
      els.pdfBtnOpenTab.addEventListener('click', () => {
        const doc = state.docViewer.currentDoc;
        if (doc && typeof window !== 'undefined') {
          window.open(doc.filePath, '_blank', 'noopener,noreferrer');
        }
      });
    }

    if (els.btnReloadSnapshot) {
      els.btnReloadSnapshot.addEventListener('click', () => {
        const selected = els.snapshotSelector ? els.snapshotSelector.value : 'data/published.json';
        loadData(selected);
      });
    }

    if (els.btnRollbackRev1) {
      els.btnRollbackRev1.addEventListener('click', () => {
        if (els.snapshotSelector) els.snapshotSelector.value = 'data/snapshots/snapshot_rev1.json';
        loadData('data/snapshots/snapshot_rev1.json');
      });
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', () => {
        if (state.docViewer.status === 'ready' && !state.docViewer.isBadPdf) {
          applyZoom();
        }
      });
    }
  }

  function init() {
    registerEvents();
    loadData('data/published.json');
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // Export internal core for testing
  return {
    state: state,
    loadData: loadData,
    renderDocDisplay: renderDocDisplay,
    renderPdfPage: renderPdfPage,
    renderBadPdfDegradation: renderBadPdfDegradation,
    populateDocSelector: populateDocSelector,
    updateDocToolbar: updateDocToolbar,
    applyZoom: applyZoom,
    computePdfDisplayDimensions: computePdfDisplayDimensions,
    normalizeAndValidatePath: normalizeAndValidatePath,
    getFilteredDocuments: getFilteredDocuments,
    getActiveDocRequestId: () => activeDocRequestId,
    getActivePageRequestId: () => activePageRequestId
  };
});
