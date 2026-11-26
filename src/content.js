/*
 * TL;DR 140 — content script
 *
 * Finds long posts in the LinkedIn feed, replaces the body with a short summary,
 * and keeps the original one click away.
 *
 * Detection strategy (updated 2026-10-27):
 * LinkedIn's feed is now server-driven UI with hashed CSS classes (.mwylux etc),
 * so class-name selectors are worthless. We target data-testid attributes instead,
 * which are far more stable, and treat the TEXT BOX itself as the unit of work
 * rather than hunting for a post container — the container's depth varies between
 * post types (plain post, repost, promoted) and we never actually needed it.
 * Legacy class selectors are kept as a fallback for older LinkedIn builds.
 * If nothing matches, the extension does nothing rather than mangling the page.
 */
(function () {
  'use strict';

  const ENGINE = globalThis.TLDR140;
  if (!ENGINE) return;

  const MARK = 'data-tldr140';

  const DEFAULTS = {
    enabled: true,
    limit: 140,
    minLength: 320,   // don't bother with posts that are already short
    mode: 'auto',     // 'auto' | 'ai' | 'local'
    outputLang: 'en', // AI tiers only; Chrome supports en/de/es/fr/ja
  };

  let settings = { ...DEFAULTS };
  let stats = { shortened: 0, charsSaved: 0 };

  // ---------------------------------------------------------------- selectors

  // Current LinkedIn first, legacy builds after.
  const BODY_SELECTORS = [
    '[data-testid="expandable-text-box"]',
    '.feed-shared-inline-show-more-text',
    '.feed-shared-update-v2__description',
    '.update-components-text',
    '.feed-shared-text',
  ];
  const BODY_QUERY = BODY_SELECTORS.join(',');

  // Places a text box can appear that we should leave alone.
  const EXCLUDE_ANCESTORS = [
    '[role="dialog"]',
    '[data-testid="dialog-content"]',
    '.comments-comment-item',
    '.comments-comment-box',
    'form',
  ].join(',');

  function isExcluded(el) {
    try { return !!el.closest(EXCLUDE_ANCESTORS); } catch (_) { return false; }
  }

  // The text box is a <span> inside a <p>. Dropping a <div> card in there would be
  // invalid nesting and renders badly, so climb out of inline context first and
  // insert the card as a sibling of the <p>, in block context.
  const INLINE_TAGS = new Set(['P', 'SPAN', 'EM', 'STRONG', 'A', 'B', 'I', 'LABEL', 'SMALL']);

  function insertionAnchor(body) {
    let anchor = body;
    while (
      anchor.parentNode &&
      anchor.parentNode.nodeType === 1 &&
      INLINE_TAGS.has(anchor.parentNode.tagName)
    ) {
      anchor = anchor.parentNode;
    }
    return anchor;
  }

  /** Every post-body element under `root`, outermost only. */
  function findBodies(root) {
    const found = new Set();

    let nodes;
    try { nodes = root.querySelectorAll(BODY_QUERY); } catch (_) { nodes = []; }
    nodes.forEach((n) => found.add(n));

    // The mutation may have delivered the text box itself.
    if (root.nodeType === 1) {
      try { if (root.matches(BODY_QUERY)) found.add(root); } catch (_) {}
    }

    return [...found].filter((el) => {
      if (isExcluded(el)) return false;
      // Reposts nest a text box inside another; only handle the outermost.
      for (const other of found) {
        if (other !== el && other.contains(el)) return false;
      }
      return true;
    });
  }

  // ---------------------------------------------------------------- cache

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return 'h' + (h >>> 0).toString(36);
  }

  const memCache = new Map();

  async function cacheGet(key) {
    if (memCache.has(key)) return memCache.get(key);
    try {
      const got = await chrome.storage.local.get(key);
      if (got && got[key]) { memCache.set(key, got[key]); return got[key]; }
    } catch (_) {}
    return null;
  }

  async function cacheSet(key, value) {
    memCache.set(key, value);
    try { await chrome.storage.local.set({ [key]: value }); } catch (_) {}
    if (memCache.size > 600) {
      const drop = [...memCache.keys()].slice(0, 200);
      drop.forEach((k) => memCache.delete(k));
      try { await chrome.storage.local.remove(drop); } catch (_) {}
    }
  }

  // ---------------------------------------------------------------- queue
  // One model session, one post at a time. Summarising eagerly on a fast scroll
  // would queue dozens of inferences and make the feed feel broken.

  const queue = [];
  let working = false;

  function enqueue(job) {
    queue.push(job);
    drain();
  }

  async function drain() {
    if (working) return;
    working = true;
    while (queue.length) {
      const job = queue.shift();
      if (!job.body.isConnected) continue;
      try { await job.run(); } catch (err) { console.debug('[TL;DR 140]', err); }
    }
    working = false;
  }

  // ---------------------------------------------------------------- rendering

  function buildCard(body) {
    const card = document.createElement('div');
    // --loading animates the gradient bar; removed as soon as a summary lands.
    card.className = 'tldr140-card tldr140-card--loading';

    const text = document.createElement('p');
    text.className = 'tldr140-summary';
    text.textContent = '…';

    const row = document.createElement('div');
    row.className = 'tldr140-row';

    const badge = document.createElement('span');
    badge.className = 'tldr140-badge';
    badge.textContent = 'shortening…';

    const toggle = document.createElement('button');
    toggle.className = 'tldr140-toggle';
    toggle.type = 'button';
    toggle.textContent = 'Show original';
    toggle.setAttribute('aria-expanded', 'false');

    let expanded = false;
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      expanded = !expanded;
      body.classList.toggle('tldr140-hidden', !expanded);
      card.classList.toggle('tldr140-card--expanded', expanded);
      toggle.textContent = expanded ? 'Hide original' : 'Show original';
      toggle.setAttribute('aria-expanded', String(expanded));
    });

    row.appendChild(badge);
    row.appendChild(toggle);
    card.appendChild(text);
    card.appendChild(row);

    return { card, text, badge };
  }

  async function processBody(body) {
    if (!settings.enabled) return;
    if (body.hasAttribute(MARK)) return;
    if (isExcluded(body)) return;

    const original = (body.innerText || '').trim();
    if (original.length < settings.minLength) return;
    if (!body.parentNode) return;

    body.setAttribute(MARK, 'pending');

    const anchor = insertionAnchor(body);
    if (!anchor.parentNode) return;

    const key = `s:${settings.limit}:${settings.mode}:${settings.outputLang}:${hash(original)}`;
    const { card, text, badge } = buildCard(body);
    anchor.parentNode.insertBefore(card, anchor);
    body.classList.add('tldr140-hidden');

    const render = (result) => {
      if (!result || !result.text) {
        // Nothing useful came back — restore the post rather than hiding it.
        card.remove();
        body.classList.remove('tldr140-hidden');
        body.setAttribute(MARK, 'skipped');
        return;
      }
      // Hand off from the indefinite loading flow to exactly 3 settling cycles.
      card.classList.remove('tldr140-card--loading');
      card.classList.add('tldr140-card--settling');
      // animationend fires once, after the final iteration — drop the class so the
      // card is left in a clean static state.
      card.addEventListener(
        'animationend',
        () => card.classList.remove('tldr140-card--settling'),
        { once: true }
      );
      text.textContent = result.text;
      const labels = { prompt: 'on-device AI', summarizer: 'on-device AI', extractive: 'fast local' };
      badge.textContent = `${result.text.length}/${settings.limit} · ${labels[result.engine] || result.engine}`;
      body.setAttribute(MARK, 'done');

      stats.shortened += 1;
      stats.charsSaved += Math.max(0, original.length - result.text.length);
      try { chrome.storage.local.set({ stats }); } catch (_) {}
    };

    const cached = await cacheGet(key);
    if (cached) { render(cached); return; }

    enqueue({
      body,
      run: async () => {
        const result = await ENGINE.summarize(original, settings.limit, settings.mode, settings.outputLang);
        if (result && result.text) await cacheSet(key, result);
        render(result);
      },
    });
  }

  // ---------------------------------------------------------------- observers

  // Only summarise posts the reader is about to reach.
  const seen = new WeakSet();
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          io.unobserve(entry.target);
          processBody(entry.target);
        }
      }
    },
    { rootMargin: '600px 0px' }
  );

  function register(root) {
    for (const body of findBodies(root)) {
      if (seen.has(body)) continue;
      seen.add(body);
      io.observe(body);
    }
  }

  let scheduled = false;
  let pending = [];
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) if (node.nodeType === 1) pending.push(node);
    }
    if (scheduled || pending.length === 0) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const batch = pending;
      pending = [];
      for (const node of batch) {
        if (node.isConnected) register(node);
      }
    });
  });

  // ---------------------------------------------------------------- teardown

  function restoreAll() {
    document.querySelectorAll('.tldr140-card').forEach((c) => c.remove());
    document.querySelectorAll('.tldr140-hidden').forEach((b) => b.classList.remove('tldr140-hidden'));
    document.querySelectorAll(`[${MARK}]`).forEach((b) => b.removeAttribute(MARK));
  }

  // ---------------------------------------------------------------- health check
  /*
   * LinkedIn renders the feed with hashed class names that change without notice.
   * When that happens BODY_SELECTORS stops matching and the extension silently does
   * nothing — correct behaviour, but indistinguishable from "this extension is junk".
   *
   * So: a few seconds after a feed page settles, check whether we found any posts at
   * all. If the page is clearly populated and we still found none, the selectors have
   * gone stale. Record that so the popup can say so and the icon can carry a quiet
   * badge, instead of leaving the user to guess.
   */
  const HEALTH_KEY = 'health';
  const HEALTH_DELAY_MS = 9000;
  let healthTimer = null;

  const looksLikeFeedPage = () => /^\/feed/.test(location.pathname);

  function reportHealth(state, found) {
    const payload = { state, found, at: Date.now() };
    try {
      payload.version = chrome.runtime.getManifest().version;
    } catch (_) {}
    try { chrome.storage.local.set({ [HEALTH_KEY]: payload }); } catch (_) {}
    // The badge lives on the action, which a content script can't touch — hand it
    // to the service worker, which scopes it to this tab.
    try { chrome.runtime.sendMessage({ type: 'tldr140:health', state }); } catch (_) {}
  }

  function scheduleHealthCheck() {
    if (!looksLikeFeedPage()) return;
    if (healthTimer) clearTimeout(healthTimer);
    healthTimer = setTimeout(() => {
      let found = 0;
      try { found = findBodies(document.body).length; } catch (_) {}
      if (found > 0) { reportHealth('ok', found); return; }

      // Nothing matched. Distinguish "selectors are stale" from "page never loaded":
      // only claim staleness when the page clearly rendered a substantial feed.
      const populated = (document.body.innerText || '').length > 2000;
      reportHealth(populated ? 'stale' : 'unknown', 0);
    }, HEALTH_DELAY_MS);
  }

  function start() {
    register(document.body);
    mo.observe(document.body, { childList: true, subtree: true });
    scheduleHealthCheck();
  }

  // ---------------------------------------------------------------- boot

  async function init() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULTS);
      settings = { ...DEFAULTS, ...stored };
      const s = await chrome.storage.local.get('stats');
      if (s && s.stats) stats = s.stats;
    } catch (_) {}

    if (!settings.enabled) return;
    start();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const before = { ...settings };
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;

    if (before.enabled && !settings.enabled) {
      restoreAll();
      mo.disconnect();
      return;
    }
    if (!before.enabled && settings.enabled) {
      start();
      return;
    }
    if (
      before.limit !== settings.limit ||
      before.mode !== settings.mode ||
      before.minLength !== settings.minLength ||
      before.outputLang !== settings.outputLang
    ) {
      ENGINE.reset();
      restoreAll();
      findBodies(document.body).forEach((b) => processBody(b));
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
