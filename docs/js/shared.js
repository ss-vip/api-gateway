/* ===== Shared JS utilities (console.html + docs/index.html) ===== */

/**
 * Toast notification — appends a Bootstrap-style toast.
 * Auto-creates #toasts container if missing.
 */
function toast(m, ok) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.className = 'toast-container position-fixed bottom-0 end-0 p-3';
    document.body.appendChild(box);
  }
  const e = document.createElement('div');
  e.className = 'toast align-items-center text-white border-0 show bg-'
    + (ok ? 'success' : 'danger');
  e.innerHTML = '<div class="d-flex"><div class="toast-body">' + m + '</div></div>';
  box.appendChild(e);
  setTimeout(() => { e.classList.remove('show'); setTimeout(() => e.remove(), 300); }, 4000);
}

/**
 * Show loading overlay with optional auto-timeout.
 * Falls back with a toast if the timeout fires.
 * @param {string}  msg  — overlay message (default: 'Loading...')
 * @param {number}  ms   — auto-timeout in ms (default: 8000)
 */
let _overlayTimer = null;

function showLoading(msg = 'Loading...', ms = 8000) {
  const ov = document.getElementById('overlay');
  const lbl = document.getElementById('overlayMsg');
  if (!ov) return;
  if (lbl) lbl.textContent = msg;
  ov.classList.remove('d-none');
  ov.classList.add('d-flex');
  if (_overlayTimer) clearTimeout(_overlayTimer);
  _overlayTimer = setTimeout(() => {
    hideLoading();
    toast('Connection timeout — please retry', 0);
  }, ms);
}

/**
 * Hide loading overlay and reset its message.
 * @param {string} msg — reset message (default: 'Loading...')
 */
function hideLoading(msg = 'Loading...') {
  if (_overlayTimer) { clearTimeout(_overlayTimer); _overlayTimer = null; }
  const ov = document.getElementById('overlay');
  const lbl = document.getElementById('overlayMsg');
  if (!ov) return;
  ov.classList.add('d-none');
  ov.classList.remove('d-flex');
  if (lbl) lbl.textContent = msg;
}

/**
 * Initialise i18n-jsautotranslate translation layer.
 * Both console.html and docs/index.html use this; only the
 * language-dropdown selector differs between them.
 *
 * Overlay lifecycle:
 *   1. showOverlay()        → shows transOverlay, resets guards
 *   2. renderTaskFinish     → sets finishHandled flag (does NOT hide — DOM may still be rendering)
 *   3. MutationObserver     → detects DOM text changes, debounce 600ms after LAST change
 *   4. hideOverlay()        → hides transOverlay + success toast (only once per cycle)
 *   5. 5s timeout           → failOverlay() → hide + error toast + disconnect observer
 *
 * @param {string} itemsSelector — CSS selector for language menu items
 *   docs/index.html: '#langDropdown + .dropdown-menu .dropdown-item'
 *   console.html:    '#langMenu .lang-item'
 * @param {string} defaultLang — default language key (default 'english')
 * @param {string} toastOk   — toast text on success (default '翻譯完成')
 * @param {string} toastErr  — toast text on failure (default '翻譯失敗')
 */
/**
 * @param {string} toastTimeout — toast text on connection timeout (default 'Connection timeout')
 */
function initTranslation(itemsSelector, defaultLang = 'english',
                         toastOk = '翻譯完成', toastErr = '翻譯失敗',
                         toastTimeout = '連線逾時，請稍後再試') {
  const items = document.querySelectorAll(itemsSelector);
  const savedLang = localStorage.getItem('gw_lang') || defaultLang;
  const transOverlay = document.getElementById('transOverlay');
  let transTimer = null;
  let overlayHidden = false;
  let transFailed = false;
  let toastShown = false;       // Guard: only toast once per cycle
  let finishHandled = false;   // Guard: only handle renderTaskFinish once
  let hideDebounce = null;     // Debounce timer for MutationObserver
  let obs = null;

  function markActive(lang) {
    items.forEach(item => {
      item.classList.toggle('active',
        item.getAttribute('data-lang') === lang);
    });
  }

  function showOverlay() {
    if (!overlayHidden) transOverlay.classList.add('show');
    toastShown = false;
    finishHandled = false;
    transFailed = false;
    if (hideDebounce) { clearTimeout(hideDebounce); hideDebounce = null; }
  }

  function hideOverlay() {
    overlayHidden = true;
    transOverlay.classList.remove('show');
    if (transTimer) { clearTimeout(transTimer); transTimer = null; }
    if (!transFailed && !toastShown) {
      toastShown = true;
      toast(toastOk, 1);
    }
    // NOTE: do NOT disconnect obs here — let it keep watching for subsequent
    // translation cycles. Only disconnect on timeout (failOverlay).
    transFailed = false;
  }

  function failOverlay(isTimeout) {
    transFailed = true;
    toastShown = true;  // Prevent success toast
    hideOverlay();
    if (obs) { obs.disconnect(); }  // Stop observing on failure
    toast(isTimeout ? toastTimeout : toastErr, 0);
  }

  // ---- Set up MutationObserver BEFORE translation starts ----
  // Debounce: wait 600ms after the LAST DOM text change before hiding
  let latestText = document.body.textContent || '';
  obs = new MutationObserver(() => {
    const currentText = document.body.textContent || '';
    if (currentText !== latestText && currentText.length > 100) {
      latestText = currentText;
      if (hideDebounce) clearTimeout(hideDebounce);
      hideDebounce = setTimeout(() => {
        hideOverlay();
        hideDebounce = null;
      }, 600);
    }
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });

  // ---- Hook: signal render finish (do NOT hide directly) ----
  // jAutotranslate may fire renderTaskFinish before all DOM mutations
  // are applied. We set a flag but let the MutationObserver handle
  // the actual hide after text stabilises.
  if (translate.listener && typeof translate.listener.renderTaskFinish === 'function') {
    const orig = translate.listener.renderTaskFinish;
    translate.listener.renderTaskFinish = function () {
      if (finishHandled) return;
      finishHandled = true;
      // Let MutationObserver detect DOM completion, then hideOverlay()
      if (typeof orig === 'function') orig();
    };
  }

  // ---- Start translation (defer until DOM is fully loaded) ----
  // jAutotranslate warns if translate.execute() fires while
  // document.readyState == 'loading'. Guard with DOMContentLoaded.
  const startTranslate = () => {
    try {
      translate.language.setLocal(defaultLang);
      translate.service.use('client.edge');
      // Pass null as 2nd arg to avoid "conditionFunction type not function" warning
      translate.ignore.class.push('notranslate', null);
      translate.listener.start();
      translate.execute();

      // Auto-switch if a non-default language was saved
      // (moved inside startTranslate so it fires after execute, not before DOM ready)
      if (savedLang !== defaultLang) {
        showOverlay();
        transTimer = setTimeout(() => failOverlay(true), 5000);  // Timeout
        setTimeout(() => {
          try { translate.changeLanguage(savedLang); }
          catch (e) { failOverlay(false); }
        }, 300);
      }
    } catch (e) {
      failOverlay(false);  // API/library error - not a timeout
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startTranslate);
  } else {
    startTranslate();
  }

  markActive(savedLang);

  // Click handler for language dropdown
  items.forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      const lang = item.getAttribute('data-lang');
      localStorage.setItem('gw_lang', lang);
      markActive(lang);
      overlayHidden = false;
      transFailed = false;
      toastShown = false;
      finishHandled = false;
      showOverlay();
      transTimer = setTimeout(() => failOverlay(true), 5000);  // Timeout
      try { translate.changeLanguage(lang); }
      catch (e) { failOverlay(false); }  // API/library error
    });
  });
}
