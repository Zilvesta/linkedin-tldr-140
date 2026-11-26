/*
 * TL;DR 140 — service worker
 *
 * Sole job: put a quiet badge on the toolbar icon when the content script reports
 * that LinkedIn's markup has moved and post detection has stopped matching.
 *
 * Needs no permissions — chrome.action is available because the manifest declares
 * an "action". The badge is scoped to the reporting tab, so a stale feed tab does
 * not mark the icon everywhere.
 */
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'tldr140:health') return;

  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (tabId === undefined) return;

  const stale = msg.state === 'stale';

  try {
    chrome.action.setBadgeText({ tabId, text: stale ? '!' : '' });
    if (stale) {
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#B26A00' });
    }
    chrome.action.setTitle({
      tabId,
      title: stale
        ? 'TL;DR 140 — LinkedIn changed its page layout; an update is needed'
        : 'TL;DR 140',
    });
  } catch (_) {
    // A tab can disappear between the report and this call; nothing to do.
  }
});
