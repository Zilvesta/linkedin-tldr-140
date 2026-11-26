/*
 * TL;DR 140 — summarization engine
 *
 * Three tiers, tried in order:
 *   1. Prompt API (LanguageModel)  — Gemini Nano on-device. Best quality, honours a char budget.
 *   2. Summarizer API              — Gemini Nano on-device, headline mode. No char control, so we trim.
 *   3. Extractive                  — pure JS, no model. Works on every machine, instantly.
 *
 * Tiers 1 and 2 need a capable desktop (roughly: >22 GB free disk, >4 GB VRAM, unmetered
 * connection) and a one-time ~2 GB model download. Tier 3 is the reason this still works
 * for everyone else.
 */
globalThis.TLDR140 = (function () {
  'use strict';

  // ---------------------------------------------------------------- text cleanup

  // LinkedIn slop is often typed in Mathematical Alphanumeric Symbols (𝗳𝗮𝗸𝗲 𝗯𝗼𝗹𝗱) because
  // the platform has no bold button. It wrecks both the model and the extractive scorer,
  // so fold it back to ASCII first.
  const UNICODE_BLOCKS = [
    // [start, upperA, lowerA, zero]  — null means that block has no run of that kind
    [0x1d400, 0x1d400, 0x1d41a, null], // bold
    [0x1d434, 0x1d434, 0x1d44e, null], // italic
    [0x1d468, 0x1d468, 0x1d482, null], // bold italic
    [0x1d49c, 0x1d49c, 0x1d4b6, null], // script
    [0x1d4d0, 0x1d4d0, 0x1d4ea, null], // bold script
    [0x1d504, 0x1d504, 0x1d51e, null], // fraktur
    [0x1d538, 0x1d538, 0x1d552, null], // double-struck
    [0x1d5a0, 0x1d5a0, 0x1d5ba, null], // sans
    [0x1d5d4, 0x1d5d4, 0x1d5ee, null], // sans bold
    [0x1d608, 0x1d608, 0x1d622, null], // sans italic
    [0x1d670, 0x1d670, 0x1d68a, null], // monospace
  ];
  const DIGIT_BLOCKS = [0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6];

  function foldFancyUnicode(str) {
    let out = '';
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      let mapped = null;

      if (cp >= 0x1d400 && cp <= 0x1d7ff) {
        for (const [, upper, lower] of UNICODE_BLOCKS) {
          if (cp >= upper && cp < upper + 26) { mapped = String.fromCharCode(65 + cp - upper); break; }
          if (cp >= lower && cp < lower + 26) { mapped = String.fromCharCode(97 + cp - lower); break; }
        }
        if (mapped === null) {
          for (const zero of DIGIT_BLOCKS) {
            if (cp >= zero && cp < zero + 10) { mapped = String.fromCharCode(48 + cp - zero); break; }
          }
        }
      } else if (cp >= 0xff21 && cp <= 0xff3a) {      // fullwidth A-Z
        mapped = String.fromCharCode(65 + cp - 0xff21);
      } else if (cp >= 0xff41 && cp <= 0xff5a) {      // fullwidth a-z
        mapped = String.fromCharCode(97 + cp - 0xff41);
      } else if (cp >= 0xff10 && cp <= 0xff19) {      // fullwidth 0-9
        mapped = String.fromCharCode(48 + cp - 0xff10);
      } else if (cp >= 0x24b6 && cp <= 0x24cf) {      // circled A-Z
        mapped = String.fromCharCode(65 + cp - 0x24b6);
      } else if (cp >= 0x24d0 && cp <= 0x24e9) {      // circled a-z
        mapped = String.fromCharCode(97 + cp - 0x24d0);
      }

      out += mapped === null ? ch : mapped;
    }
    return out;
  }

  const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}]/gu;

  // Tails that carry no information: CTAs, hashtag dumps, follow-begging.
  const TAIL_RE = new RegExp(
    '(?:^|\\n)\\s*(?:' +
      'p\\.?s\\.?[:\\s]|' +
      '(?:follow|connect with) me\\b|' +
      "(?:what(?:'| i)?s your|agree\\?|thoughts\\?|am i wrong\\?)|" +
      '(?:repost|share) (?:this|if)\\b|' +
      '(?:♻️|🔔|👇|👆)|' +
      '(?:like (?:and|&) (?:share|repost|comment))|' +
      'drop a (?:comment|"?\\w+"?) below|' +
      'tag someone\\b' +
    ')[\\s\\S]*$',
    'i'
  );

  function cleanPostText(raw) {
    let t = foldFancyUnicode(String(raw || ''));
    t = t.replace(/\r/g, '');
    t = t.replace(/https?:\/\/\S+/g, ' ');            // URLs
    t = t.replace(/(?:^|\s)#[\p{L}\p{N}_]+/gu, ' ');   // hashtags
    t = t.replace(/(?:^|\s)@[\p{L}\p{N}_.-]+/gu, ' '); // @mentions
    t = t.replace(/\bhashtag\b/gi, ' ');               // LinkedIn's a11y text leaks this in
    t = t.replace(TAIL_RE, '');
    t = t.replace(EMOJI_RE, ' ');
    t = t.replace(/^[\s\-–—•*·>→✓✔]+/gm, '');          // decorative bullets
    t = t.replace(/[ \t]{2,}/g, ' ');
    t = t.replace(/\n{2,}/g, '\n');
    return t.trim();
  }

  // ---------------------------------------------------------------- output shaping

  function tidyOutput(s) {
    let out = String(s || '').trim();
    out = out.replace(EMOJI_RE, '').trim();
    // Models love a preamble. Strip it.
    out = out.replace(/^(?:summary|tl;?dr|headline|in short|the post)\s*[:\-–]\s*/i, '');
    out = out.replace(/^(?:the (?:author|poster|writer)|this post)\s+(?:is\s+)?(?:says?|argues?|claims?|states?|describ\w+|discuss\w+|explain\w+)\s+(?:that\s+)?/i, '');
    out = out.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
    out = out.replace(/\s+/g, ' ').trim();
    if (out) out = out[0].toUpperCase() + out.slice(1);
    return out;
  }

  // Cut to `limit` characters without slicing a word in half.
  function hardTrim(s, limit) {
    if (s.length <= limit) return s;
    let cut = s.slice(0, limit - 1);
    const space = cut.lastIndexOf(' ');
    if (space > limit * 0.55) cut = cut.slice(0, space);
    return cut.replace(/[\s,;:.\-–—]+$/, '') + '…';
  }

  /*
   * Preferred trimmer. Cutting at `limit` mid-phrase produces things like
   * "…and how Ciphix helps to…", which reads as a broken box rather than a summary.
   * Cutting at the last clause boundary that fits gives a shorter but COMPLETE
   * thought, and needs no ellipsis. Falls back to hardTrim when there's no usable
   * boundary. Punctuation-based, so it works regardless of language.
   */
  function clauseTrim(s, limit) {
    if (s.length <= limit) return s;

    const breaks = [];
    const re = /[,;:—–]/g;
    let m;
    while ((m = re.exec(s)) !== null) breaks.push(m.index);

    const fitting = breaks.filter((i) => i <= limit);
    const best = fitting[fitting.length - 1];

    // Only take the clause if it's substantial — a 15-character fragment is worse
    // than a truncated sentence.
    if (best !== undefined && best >= limit * 0.35) {
      return s.slice(0, best).replace(/[\s,;:.\-–—]+$/, '');
    }
    return hardTrim(s, limit);
  }

  // ---------------------------------------------------------------- tier 3: extractive

  const STOPWORDS = new Set(('a an the and or but if then than that this these those i me my we our you your he she it they them ' +
    'is are was were be been being am do does did doing have has had having will would can could should may might must ' +
    'of in on at to for with from by about as into over after before between out up down so just not no nor only own same ' +
    'too very s t don now here there when where why how all any both each few more most other some such').split(' '));

  // Hype markers: sentences that are pure LinkedIn performance, not content.
  const HYPE_RE = /\b(?:game[- ]?chang\w+|unpopular opinion|hot take|let that sink in|needle[- ]?mov\w+|synerg\w+|leverag\w+|disrupt\w+|paradigm|humbled|thrilled|excited to (?:announce|share)|grateful|blessed|journey|rockstar|ninja|guru|10x|north star|circle back|deep dive|low[- ]hanging)\b/i;

  function splitSentences(text) {
    return text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function extractive(text, limit) {
    const sentences = splitSentences(text);
    if (sentences.length === 0) return '';
    if (sentences.length === 1) return clauseTrim(tidyOutput(sentences[0]), limit);

    // Term frequency over content words.
    const freq = new Map();
    for (const s of sentences) {
      for (const w of s.toLowerCase().match(/[\p{L}\p{N}'-]+/gu) || []) {
        if (w.length < 3 || STOPWORDS.has(w)) continue;
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
    const maxFreq = Math.max(1, ...freq.values());

    let best = null;
    sentences.forEach((s, i) => {
      const words = s.toLowerCase().match(/[\p{L}\p{N}'-]+/gu) || [];
      const content = words.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
      if (content.length === 0) return;

      let score = content.reduce((acc, w) => acc + (freq.get(w) || 0) / maxFreq, 0) / Math.sqrt(content.length);

      // Opening lines of a slop post are the hook, not the point — mildly penalise the
      // very first line, reward the early-middle where the actual claim usually lands.
      if (i === 0) score *= 0.85;
      else if (i <= Math.max(2, sentences.length * 0.4)) score *= 1.15;

      if (HYPE_RE.test(s)) score *= 0.45;
      if (s.length < 25) score *= 0.5;                 // one-word drama lines
      if (/\?$/.test(s)) score *= 0.7;                 // rhetorical questions
      if (/\d/.test(s)) score *= 1.1;                  // concrete numbers are signal

      // Strongly prefer a sentence that survives intact. A slightly less "important"
      // sentence that fits beats a better one that gets cut off mid-phrase.
      if (s.length <= limit) score *= 1.35;
      else if (s.length > limit * 2.5) score *= 0.75;

      if (!best || score > best.score) best = { score, text: s };
    });

    const chosen = best ? best.text : sentences[0];
    return clauseTrim(tidyOutput(chosen), limit);
  }

  // ---------------------------------------------------------------- tiers 1 & 2: on-device AI

  /*
   * Chrome's built-in models only ATTEST output safety for these languages, and
   * refuse the request without an explicit declaration. Dutch is not among them,
   * so a Dutch post summarised by the AI tier comes back in whichever of these
   * the user picks. The extractive tier has no such limit and keeps the original
   * language — which is often the better choice for non-English feeds.
   */
  const OUTPUT_LANGUAGES = {
    en: 'English',
    de: 'German',
    es: 'Spanish',
    fr: 'French',
    ja: 'Japanese',
  };
  const DEFAULT_LANG = 'en';
  const normLang = (l) => (Object.prototype.hasOwnProperty.call(OUTPUT_LANGUAGES, l) ? l : DEFAULT_LANG);

  const hasPromptAPI = () => typeof globalThis.LanguageModel !== 'undefined';
  const hasSummarizerAPI = () => typeof globalThis.Summarizer !== 'undefined';

  let promptSession = null;
  let summarizerInstance = null;
  let sessionLimit = null;
  let sessionLang = null;
  let summarizerLang = null;

  function systemPromptFor(limit, lang) {
    const name = OUTPUT_LANGUAGES[normLang(lang)];
    return [
      'You compress LinkedIn posts for a reader who does not want to read them.',
      `Reply with ONE plain sentence of at most ${limit} characters stating the post's actual substantive point.`,
      `Always write the sentence in ${name}, whatever language the post is in.`,
      'Rules: no emoji, no hashtags, no hype adjectives, no quotation marks, no preamble, no "the author".',
      'Do not editorialise and do not add information that is not in the post.',
      'If the post makes no substantive point, reply exactly: No actual point made.',
      'Output only the sentence.',
    ].join(' ');
  }

  async function availability(lang = DEFAULT_LANG) {
    const want = normLang(lang);
    const result = { prompt: 'unsupported', summarizer: 'unsupported' };
    try {
      if (hasPromptAPI()) {
        result.prompt = await LanguageModel.availability({
          expectedOutputs: [{ type: 'text', languages: [want] }],
        });
      }
    } catch (_) { result.prompt = 'unavailable'; }
    try {
      if (hasSummarizerAPI()) {
        result.summarizer = await Summarizer.availability({ outputLanguage: want });
      }
    } catch (_) { result.summarizer = 'unavailable'; }
    return result;
  }

  async function getPromptSession(limit, lang, onProgress) {
    const want = normLang(lang);
    if (promptSession && sessionLimit === limit && sessionLang === want) return promptSession;
    if (promptSession) { try { promptSession.destroy(); } catch (_) {} promptSession = null; }

    const opts = {
      initialPrompts: [{ role: 'system', content: systemPromptFor(limit, want) }],
      // Required: Chrome rejects the request outright without a declared output
      // language ("No output language was specified in a LanguageModel API request").
      expectedOutputs: [{ type: 'text', languages: [want] }],
    };
    if (onProgress) {
      opts.monitor = (m) => m.addEventListener('downloadprogress', (e) => onProgress(e.loaded));
    }
    try {
      const params = await LanguageModel.params();      // extensions-only, tolerate absence
      if (params && typeof params.defaultTopK === 'number') {
        opts.temperature = 0.2;                          // we want terse and literal, not creative
        opts.topK = Math.min(3, params.maxTopK ?? 3);
      }
    } catch (_) {}

    promptSession = await LanguageModel.create(opts);
    sessionLimit = limit;
    sessionLang = want;
    return promptSession;
  }

  async function viaPrompt(text, limit, lang, onProgress) {
    const session = await getPromptSession(limit, lang, onProgress);
    // Keep well inside the context window; the point of a post is rarely in its last paragraph.
    const input = text.length > 4000 ? text.slice(0, 4000) : text;
    const raw = await session.prompt(`Post:\n"""\n${input}\n"""`);
    const out = tidyOutput(raw);
    if (!out) throw new Error('empty model output');
    return clauseTrim(out, limit);
  }

  async function getSummarizer(lang, onProgress) {
    const want = normLang(lang);
    if (summarizerInstance && summarizerLang === want) return summarizerInstance;
    if (summarizerInstance) { try { summarizerInstance.destroy(); } catch (_) {} summarizerInstance = null; }
    const opts = {
      type: 'headline',
      format: 'plain-text',
      length: 'short',
      outputLanguage: want,          // same attestation requirement as the Prompt API
      sharedContext:
        'A LinkedIn feed post. These are usually padded with filler, hype and formatting tricks. ' +
        'Capture only the substantive point.',
    };
    if (onProgress) {
      opts.monitor = (m) => m.addEventListener('downloadprogress', (e) => onProgress(e.loaded));
    }
    summarizerInstance = await Summarizer.create(opts);
    summarizerLang = want;
    return summarizerInstance;
  }

  async function viaSummarizer(text, limit, lang, onProgress) {
    const s = await getSummarizer(lang, onProgress);
    const raw = await s.summarize(text.length > 4000 ? text.slice(0, 4000) : text);
    const out = tidyOutput(raw);
    if (!out) throw new Error('empty summarizer output');
    return clauseTrim(out, limit);
  }

  // ---------------------------------------------------------------- public API

  /**
   * @param rawText  the post text straight off the page
   * @param limit    character budget (default 140)
   * @param mode     'auto' | 'ai' | 'local'
   * @returns {Promise<{text: string, engine: 'prompt'|'summarizer'|'extractive', ratio: number}>}
   */
  async function summarize(rawText, limit = 140, mode = 'auto', lang = DEFAULT_LANG) {
    const cleaned = cleanPostText(rawText);
    const ratio = rawText.length ? cleaned.length / rawText.length : 1;

    if (!cleaned) return { text: '', engine: 'extractive', ratio };

    // Already short enough once the decoration is gone — nothing to do.
    if (cleaned.length <= limit) {
      return { text: tidyOutput(cleaned), engine: 'extractive', ratio };
    }

    if (mode !== 'local') {
      const avail = await availability(lang);
      if (avail.prompt === 'available') {
        try { return { text: await viaPrompt(cleaned, limit, lang), engine: 'prompt', ratio }; }
        catch (err) { console.debug('[TL;DR 140] prompt tier failed:', err); }
      }
      if (avail.summarizer === 'available') {
        try { return { text: await viaSummarizer(cleaned, limit, lang), engine: 'summarizer', ratio }; }
        catch (err) { console.debug('[TL;DR 140] summarizer tier failed:', err); }
      }
    }

    return { text: extractive(cleaned, limit), engine: 'extractive', ratio };
  }

  /**
   * Warm up / download the model. MUST be called from a user gesture (the popup button),
   * because Chrome requires transient activation before it will start the download.
   */
  async function warmUp(limit = 140, onProgress, lang = DEFAULT_LANG) {
    if (hasPromptAPI()) {
      const a = await LanguageModel.availability({
        expectedOutputs: [{ type: 'text', languages: [normLang(lang)] }],
      });
      if (a === 'available' || a === 'downloadable' || a === 'downloading') {
        await getPromptSession(limit, lang, onProgress);
        return 'prompt';
      }
    }
    if (hasSummarizerAPI()) {
      const a = await Summarizer.availability({ outputLanguage: normLang(lang) });
      if (a === 'available' || a === 'downloadable' || a === 'downloading') {
        await getSummarizer(lang, onProgress);
        return 'summarizer';
      }
    }
    return null;
  }

  function reset() {
    if (promptSession) { try { promptSession.destroy(); } catch (_) {} }
    if (summarizerInstance) { try { summarizerInstance.destroy(); } catch (_) {} }
    promptSession = null;
    summarizerInstance = null;
    sessionLimit = null;
    sessionLang = null;
    summarizerLang = null;
  }

  return {
    summarize,
    warmUp,
    OUTPUT_LANGUAGES,
    availability,
    reset,
    // exported for tests / reuse
    _internals: { cleanPostText, foldFancyUnicode, extractive, hardTrim, clauseTrim, tidyOutput },
  };
})();
