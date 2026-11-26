/* TL;DR 140 — popup
 *
 * The popup owns model download, because Chrome requires transient user activation
 * before it will start fetching Gemini Nano. A content script has no activation, so
 * the first-run download has to happen behind a button click here.
 */
(function () {
  'use strict';

  const DEFAULTS = { enabled: true, limit: 140, minLength: 320, mode: 'auto', outputLang: 'en' };

  const $ = (id) => document.getElementById(id);
  const el = {
    enabled: $('enabled'),
    limit: $('limit'),
    limitOut: $('limitOut'),
    minLength: $('minLength'),
    minOut: $('minOut'),
    mode: $('mode'),
    dot: $('dot'),
    statusText: $('statusText'),
    warm: $('warm'),
    progress: $('progress'),
    bar: $('bar'),
    stats: $('stats'),
    explain: $('explain'),
    outputLang: $('outputLang'),
    langField: $('langField'),
    langHint: $('langHint'),
    stale: $('stale'),
    staleReport: $('staleReport'),
    progressLabel: $('progressLabel'),
  };

  // Built from TLDR140.OUTPUT_LANGUAGES so the UI can never offer a language
  // Chrome would reject.
  function buildLanguages() {
    const langs = (globalThis.TLDR140 && TLDR140.OUTPUT_LANGUAGES) || { en: 'English' };
    el.outputLang.innerHTML = '';
    for (const [code, name] of Object.entries(langs)) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = name;
      el.outputLang.appendChild(o);
    }
  }

  function updateLangUi() {
    const local = el.mode.value === 'local';
    el.langField.hidden = local;
    el.langHint.textContent = local
      ? ''
      : "Chrome's model only supports these languages. Posts in any other language "
      + 'are summarised into the one you pick. Fast local keeps the '
      + "post's own language.";
  }

  function save(patch) {
    chrome.storage.sync.set(patch).catch(() => {});
  }

  // ------------------------------------------------------------- status

  function setStatus(kind, text, showButton) {
    el.dot.className = 'dot' + (kind ? ' ' + kind : '');
    el.statusText.textContent = text;
    el.warm.hidden = !showButton;
    // The explanation only matters when a download is actually on offer.
    el.explain.hidden = !showButton;
  }

  async function refreshStatus() {
    const mode = el.mode.value;

    if (mode === 'local') {
      setStatus('ok', 'Fast local summarizer. Nothing to download, works in every language.', false);
      return;
    }

    let avail;
    try {
      avail = await TLDR140.availability(el.outputLang.value);
    } catch (_) {
      avail = { prompt: 'unavailable', summarizer: 'unavailable' };
    }

    const best = ['available', 'downloading', 'downloadable'].find(
      (state) => avail.prompt === state || avail.summarizer === state
    );

    if (best === 'available') {
      setStatus('ok', "Chrome's AI model is ready. Summaries run on this device.", false);
    } else if (best === 'downloading') {
      setStatus('warn', 'Chrome is downloading its AI model. Fast local is used until it finishes.', false);
    } else if (best === 'downloadable') {
      setStatus('warn', "Chrome's AI model isn't downloaded yet. Until then, Fast local is used.", true);
    } else if (avail.prompt === 'unsupported' && avail.summarizer === 'unsupported') {
      setStatus(
        '',
        mode === 'ai'
          ? 'This Chrome has no built-in AI. Switch the engine to "Fast local".'
          : 'No built-in AI here — using the fast local summarizer.',
        false
      );
    } else {
      setStatus(
        '',
        mode === 'ai'
          ? "This device can't run the model. Switch the engine to \"Fast local\"."
          : "This device can't run the model — using the fast local summarizer.",
        false
      );
    }
  }

  el.warm.addEventListener('click', async () => {
    el.warm.disabled = true;
    el.warm.textContent = 'Starting download…';
    el.progress.hidden = false;
    try {
      el.progressLabel.hidden = false;
      el.progressLabel.textContent = 'Chrome is fetching Gemini Nano…';
      await TLDR140.warmUp(Number(el.limit.value), (loaded) => {
        const frac = typeof loaded === 'number' && loaded <= 1 ? loaded : null;
        if (frac === null) return;              // don't invent a number we don't have
        const pct = Math.round(frac * 100);
        el.bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
        el.progressLabel.textContent = `Downloading Gemini Nano — ${pct}%`;
      }, el.outputLang.value);
      el.bar.style.width = '100%';
      el.progressLabel.textContent = 'Done. Summaries now run on this device.';
      el.warm.textContent = 'Done';
    } catch (err) {
      el.warm.textContent = 'Download failed — try again';
      el.progressLabel.textContent = 'Chrome could not fetch the model. Fast local still works.';
      el.warm.disabled = false;
      console.warn('[TL;DR 140] warm-up failed:', err);
    }
    await refreshStatus();
  });

  // ------------------------------------------------------------- wiring

  el.enabled.addEventListener('change', () => save({ enabled: el.enabled.checked }));

  el.limit.addEventListener('input', () => { el.limitOut.textContent = el.limit.value; });
  el.limit.addEventListener('change', () => save({ limit: Number(el.limit.value) }));

  el.minLength.addEventListener('input', () => { el.minOut.textContent = el.minLength.value; });
  el.minLength.addEventListener('change', () => save({ minLength: Number(el.minLength.value) }));

  el.mode.addEventListener('change', () => {
    save({ mode: el.mode.value });
    updateLangUi();
    refreshStatus();
  });

  el.outputLang.addEventListener('change', () => {
    save({ outputLang: el.outputLang.value });
    el.warm.disabled = false;
    el.warm.textContent = "Download Chrome's AI model";
    refreshStatus();
  });

  // Show the "needs an update" banner only while the report is recent and came
  // from the version now installed — a stale record from an older build would
  // otherwise keep warning after the fix shipped.
  const ISSUES_URL = 'https://github.com/Zilvesta/linkedin-tldr-140/issues';

  async function refreshHealth() {
    try {
      const { health } = await chrome.storage.local.get('health');
      if (!health || health.state !== 'stale') { el.stale.hidden = true; return; }
      const sameVersion = health.version === chrome.runtime.getManifest().version;
      const fresh = Date.now() - (health.at || 0) < 7 * 24 * 60 * 60 * 1000;
      el.stale.hidden = !(sameVersion && fresh);
      el.staleReport.href = ISSUES_URL;
    } catch (_) {
      el.stale.hidden = true;
    }
  }

  // ------------------------------------------------------------- boot

  (async function init() {
    try {
      const s = await chrome.storage.sync.get(DEFAULTS);
      el.enabled.checked = s.enabled;
      el.limit.value = s.limit;
      el.limitOut.textContent = s.limit;
      el.minLength.value = s.minLength;
      el.minOut.textContent = s.minLength;
      el.mode.value = s.mode;
      buildLanguages();
      el.outputLang.value = s.outputLang || 'en';
      updateLangUi();
    } catch (_) {
      buildLanguages();
      updateLangUi();
    }

    try {
      const { stats } = await chrome.storage.local.get('stats');
      if (stats && stats.shortened) {
        const saved = Math.round(stats.charsSaved / 1000);
        el.stats.textContent =
          `${stats.shortened.toLocaleString()} posts shortened · ~${saved.toLocaleString()}k characters you didn't read.`;
      }
    } catch (_) {}

    refreshStatus();
    refreshHealth();
  })();
})();
