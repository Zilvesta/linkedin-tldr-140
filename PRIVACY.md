# Privacy Policy — TL;DR 140 for LinkedIn

_Last updated: 26 November 2026_

## Short version

This extension does not transmit, sell, or share any data. To do its job it reads
the text of posts on pages you are already viewing, and that reading and
summarising happens entirely on your own device. There is no server, no account,
and no analytics.

In the Chrome Web Store listing this is declared as handling **website content**.
That declaration covers exactly one thing: the post text the extension reads in
order to shorten it. That text is processed locally and is never sent to us, to
Google, or to anyone else.

## What the extension reads

To do its job, the extension reads the text of posts on `linkedin.com` pages you
are already viewing. This text is processed on your device to produce a short
summary and is never sent anywhere.

The extension runs only on `https://www.linkedin.com/*`. It has no access to any
other website.

## What the extension stores

All storage is provided by Chrome and stays under your control.

| What | Where | Leaves your device? |
|---|---|---|
| Your settings (on/off, summary length, engine, language) | `chrome.storage.sync` | Only via your own Chrome profile sync, if you have Chrome Sync enabled. Never to us. |
| Cached summaries of posts you have scrolled past | `chrome.storage.local` | No — device only |
| A count of posts shortened and characters saved | `chrome.storage.local` | No — device only |

Cached summaries exist so the same post is not re-summarized every time you scroll
past it. You can clear everything at any time by removing the extension.

## Optional on-device AI

If you choose to enable it, the extension uses Chrome's built-in AI APIs
(Summarizer and Prompt API), which run Google's Gemini Nano model locally on your
machine.

- The extension does not contain, download, or execute any remote code.
- The Gemini Nano model is downloaded and managed by **Chrome itself**, not by this
  extension, and is shared across your whole browser.
- Post text passed to these APIs is processed on your device. It is not sent to
  Google, to us, or to anyone else.

If you do not enable the AI engine, the extension uses a plain JavaScript
summarizer that requires no model and no download.

## Limited Use disclosure

Our use of information received from Google APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use),
including the Limited Use requirements. We do not collect, transmit, sell, or
transfer any user data. No data is used for advertising, credit assessment,
lending, or data brokering, and no data is transferred to third parties.

## Changes

If this extension's data handling ever changes, this policy will be updated and
the change disclosed to users before it takes effect.

## Contact

Questions: robert.slot@gmail.com

## Affiliation

This extension is an independent project. It is not affiliated with, endorsed by,
or sponsored by LinkedIn or Microsoft.
