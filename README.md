# TL;DR 140 for LinkedIn

A Chrome extension that shortens long LinkedIn feed posts to a 140-character
summary, with the original one click away.

Everything runs on your own device. No account, no server, no analytics, no
tracking. The extension requests one permission (`storage`) and runs only on
`linkedin.com`.

[Install from the Chrome Web Store](#) · [Privacy policy](https://gist.github.com/Zilvesta/7055922352a3728fa7ec298ec1431415)

---

## How it works

Each post is first stripped of the things that pad it out: fake-bold Unicode
(`𝗹𝗶𝗸𝗲 𝘁𝗵𝗶𝘀`), emoji, hashtags, @-mentions, URLs, and engagement-bait tails
("Agree? Drop a YES below"). That alone removes a surprising share of the volume.

Then one of three engines produces the summary, tried in order:

| Tier | Engine | Needs | Quality |
|---|---|---|---|
| 1 | **Prompt API** (`LanguageModel`, Gemini Nano) | Chrome 138+, capable desktop | Best — understands the post, honours the character budget |
| 2 | **Summarizer API** (Gemini Nano, headline mode) | Chrome 138+, capable desktop | Good — no character control, so output is trimmed |
| 3 | **Extractive** (plain JS, no model) | Nothing | Decent — scores sentences and picks the most substantive one |

Tier 3 is why the extension works for everyone. Chrome's built-in AI needs a
desktop with roughly 22 GB free disk and more than 4 GB VRAM, plus a one-time
model download that **Chrome itself** performs — this extension ships no model
and no remote code.

The extractive scorer deliberately penalises the opening line (in a padded post
that's the hook, not the point), penalises hype phrases and rhetorical questions,
and rewards sentences containing numbers. Summaries are cut at the last clause
boundary that fits, so you get a shorter but complete thought rather than a
sentence chopped mid-phrase.

### A note on languages

Chrome's built-in AI only supports English, German, Spanish, French and Japanese.
Posts in other languages are summarised *into* whichever of those you pick. The
extractive engine has no such limit and keeps the post's own language, which is
often the better choice for non-English feeds.

---

## Install from source

1. Download or clone this repository
2. Open `chrome://extensions`
3. Turn on **Developer mode**
4. Click **Load unpacked** and select the folder containing `manifest.json`

---

## When it stops working

LinkedIn renders its feed with hashed CSS class names (`.mwylux`, `.ekfkdm`) that
change without notice. When that happens, post detection breaks and the extension
silently does nothing — by design, it would rather do nothing than mangle the page.

**This will happen again.** It is the main maintenance cost of this kind of
extension, not the AI part.

Detection lives in `src/content.js` and targets `data-testid` attributes, which
are far more stable than class names:

```js
const BODY_SELECTORS = [
  '[data-testid="expandable-text-box"]',   // current LinkedIn
  '.feed-shared-inline-show-more-text',    // legacy builds
  ...
];
```

To fix it after a LinkedIn change: open a feed page, inspect a post's text
element, and add its stable attribute to the front of `BODY_SELECTORS`. Pull
requests doing exactly this are very welcome — that is a large part of why this
repository is public.

---

## Project layout

```
manifest.json        MV3 manifest; the only permission is "storage"
src/engine.js        three-tier summarizer + text cleanup (no DOM dependencies)
src/content.js       post detection, lazy queue, collapse/expand UI, caching
src/content.css      injected styles, light + dark
src/popup.html       settings and model download
src/popup.js
src/popup.css
test/engine.test.js  checks for the no-AI tier; run with `node test/engine.test.js`
make_icons.py        regenerates icons/
```

`engine.js` has no DOM dependencies, so it is reusable on its own.

---

## Limitations

Summaries are lossy by design; that is the point. On-device models are small and
occasionally miss a nuance, which is why **Show original** is always there.

---

## Reporting a problem

Open an [issue](../../issues). If the extension has stopped shortening posts,
please say which Chrome version you are on and, if you can, paste the `class` or
`data-testid` attribute of a post's text element — that is usually enough to fix
it in minutes.

---

## Not affiliated

This is an independent project. It is not affiliated with, endorsed by, or
sponsored by LinkedIn or Microsoft.

## Licence

MIT — see [LICENSE](LICENSE).
