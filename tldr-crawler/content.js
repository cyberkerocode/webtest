// content.js - TL;DR Crawler
//
// Injected by background.js on every toolbar click. Because the file is
// re-executed (not just re-registered) on each click, the whole thing is
// wrapped in an IIFE and guarded by a flag on `window` so re-injection can
// never create a second instance and never throws a "already declared"
// SyntaxError for top-level let/const.
//
// Sections (see comment banners below):
//   0. Toggle guard / global flag
//   1. Config constants
//   2. Disposables / cleanup registry
//   3. Article detection
//   4. Sentence extraction (DOM Range based)
//   5. Sentence scoring + key-sentence selection
//   6. Summarization (Claude via background.js, and local fallback)
//   7. MutationObserver (dynamic content)
//   8. Shadow DOM UI host (canvas + panel)
//   9. Highlighting (CSS Custom Highlight API + fallback)
//  10. Word glitch effects
//  11. Spider physics + IK + canvas rendering
//  12. Crawling / text-detection loop
//  13. Panel UI wiring (drag, buttons, list rendering)
//  14. Lifecycle: start() / shutdown() / restart()

(function () {
  "use strict";

  // ===========================================================================
  // 0. TOGGLE GUARD
  // ===========================================================================
  // IMPORTANT: a plain `window.__tldrCrawlerActive` flag is NOT reliable for
  // this. Each chrome.scripting.executeScript() call gets its own fresh
  // isolated-world execution context - on this browser, repeated injections
  // do NOT share custom window properties with each other at all, so a
  // flag-on-window check always reads back "not active" and every click
  // silently stacks ANOTHER independent spider/panel/physics-loop instead of
  // toggling the existing one off. sessionStorage, by contrast, is page-
  // level (shared by every script touching this document regardless of
  // which isolated world it runs in), so a "generation token" there is what
  // actually survives across separate injections.
  const TLDR_SESSION_KEY = "tldrCrawlerGeneration";
  const tldrGeneration = Date.now() + "-" + Math.random().toString(36).slice(2);

  function tldrForceRemoveArtifacts() {
    document.querySelectorAll("[data-tldr-crawler-ui]").forEach((el) => el.remove());
    try {
      if (window.Highlight && CSS.highlights) CSS.highlights.delete("tldr-found");
    } catch (_e) {
      /* ignore */
    }
    for (const attr of ["data-tldr-glitch", "data-tldr-highlight"]) {
      document.querySelectorAll(`[${attr}]`).forEach((span) => {
        const parent = span.parentNode;
        if (!parent) return;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
        parent.normalize();
      });
    }
  }

  let existingGeneration = null;
  try {
    existingGeneration = sessionStorage.getItem(TLDR_SESSION_KEY);
  } catch (_e) {
    existingGeneration = null; // storage blocked (e.g. sandboxed iframe) - proceed as if inactive
  }

  if (existingGeneration) {
    // Something (an earlier click's instance, possibly still running in its
    // own isolated world) claims to be active: this click means "turn it
    // off". Clear the shared token so that instance's own rAF loop notices
    // on its very next frame and stops itself, AND force-clean visible
    // artifacts immediately ourselves so the page looks right without
    // waiting on that other world's next tick.
    try {
      sessionStorage.removeItem(TLDR_SESSION_KEY);
    } catch (_e) {
      /* ignore */
    }
    tldrForceRemoveArtifacts();
    return;
  }
  try {
    sessionStorage.setItem(TLDR_SESSION_KEY, tldrGeneration);
  } catch (_e) {
    /* storage blocked - continue anyway, just without duplicate-injection protection */
  }

  // Same-origin iframes (e.g. an embedded job-board widget) get this exact
  // script injected into them too when background.js uses allFrames:true.
  // Only the top frame gets the visible spider/canvas/panel - iframes run a
  // lightweight "reporter" mode instead (see runIframeReporterMode below)
  // that extracts+summarizes their own text and posts it up to the top
  // frame's panel, since the spider can never visually walk across a
  // document/frame boundary (browser hit-testing stops at the iframe edge).
  const isTopFrame = window.top === window;

  // ===========================================================================
  // 1. CONFIG CONSTANTS
  // ===========================================================================
  const CFG = {
    MAX_SPEED: 420, // px/s
    STOP_DISTANCE: 40, // px from cursor at which spider stops
    WANDER_IDLE_MS: 8000,
    PHYSICS_STEP: 1 / 120,
    FOOT_STEP_TRIGGER_DIST: 80,
    STEP_DURATION: 0.13, // seconds
    FOOT_LIFT_PX: 7,
    SCAN_INTERVAL_MS: 80,
    MUTATION_DEBOUNCE_MS: 1000,
    GLITCH_CHANCE: 0.25,
    KEY_SENTENCE_MIN: 5,
    KEY_SENTENCE_MAX: 80,
    TOP_FRACTION: 0.25,
    SUMMARY_MAX_WORDS: 9,
    SUMMARY_BATCH_DEBOUNCE_MS: 450,
    BODY_LENGTH: 22, // half-length of body along facing direction (px)
    BODY_WIDTH: 12, // half-width
    THIGH_LEN: 17,
    SHIN_LEN: 17,
  };

  const EXCLUDED_SELECTOR =
    "nav, header, footer, aside, form, code, pre, script, style, noscript, textarea, [aria-hidden='true'], [data-tldr-crawler-ui]";
  const IMPORTANT_WORDS = [
    "first",
    "record",
    "launch",
    "announce",
    "announced",
    "new",
    "only",
    "biggest",
    "fastest",
    "warns",
    "raises",
    "cuts",
  ];
  const FILLER_OPENERS = ["and", "but", "however", "also"];

  const reducedMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ===========================================================================
  // 2. DISPOSABLES / CLEANUP REGISTRY
  // ===========================================================================
  const disposables = [];
  function track(fn) {
    disposables.push(fn);
    return fn;
  }
  function addListener(target, type, handler, opts) {
    target.addEventListener(type, handler, opts);
    track(() => target.removeEventListener(type, handler, opts));
  }

  // All spans we create (glitch words + fallback highlight fragments) so we
  // can restore the original text structure on restart/shutdown.
  const createdSpans = [];

  function unwrapSpan(span) {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }

  function unwrapAllSpans() {
    // Unwrap in reverse creation order; guard against spans whose parent
    // was already detached by an earlier unwrap (nested defensive check).
    while (createdSpans.length) {
      const span = createdSpans.pop();
      if (span && span.isConnected) unwrapSpan(span);
    }
  }

  // ===========================================================================
  // 3. ARTICLE DETECTION
  // ===========================================================================
  function isHidden(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    return (
      style.display === "none" ||
      style.visibility === "hidden" ||
      el.hasAttribute("hidden")
    );
  }

  function isExcluded(el) {
    if (!(el instanceof Element)) return false;
    if (el.closest(EXCLUDED_SELECTOR)) return true;
    let cur = el;
    let depth = 0;
    while (cur && depth < 25) {
      if (isHidden(cur)) return true;
      cur = cur.parentElement;
      depth++;
    }
    return false;
  }

  // td/th added because many real-world pages (job listings, gov sites,
  // legacy layouts) put their actual readable text directly inside table
  // cells with no <p> wrapper at all - without this, such pages yield zero
  // candidate blocks and the crawler finds nothing to extract.
  const BLOCK_SELECTOR = "p, li, blockquote, h2, h3, h4, td, th";

  // If a matched block CONTAINS another matched block (e.g. a <td> wrapping
  // a <p>, or a <li> wrapping a <blockquote>), only keep the innermost one -
  // otherwise the same text gets collected twice as two overlapping
  // "sentences" from two different block elements.
  function isNestedInsideAnotherBlock(el, allBlocks) {
    let cur = el.parentElement;
    while (cur) {
      if (allBlocks.has(cur)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function textLengthOf(el) {
    return (el.textContent || "").trim().length;
  }

  function findMainContentElement() {
    const article = document.querySelector("article");
    if (article && textLengthOf(article) > 200) return article;

    const main = document.querySelector("main");
    if (main && textLengthOf(main) > 200) return main;

    // Heuristic: accumulate text length of eligible paragraph-like blocks
    // up each ancestor chain, pick the ancestor with the largest total.
    const allMatched = Array.from(document.querySelectorAll(BLOCK_SELECTOR));
    const allMatchedSet = new Set(allMatched);
    const blocks = allMatched.filter(
      (b) =>
        !isExcluded(b) &&
        textLengthOf(b) >= 20 &&
        !isNestedInsideAnotherBlock(b, allMatchedSet)
    );
    if (!blocks.length) return document.body;

    const scores = new Map();
    for (const block of blocks) {
      const len = textLengthOf(block);
      let cur = block.parentElement;
      let depth = 0;
      while (cur && cur !== document.documentElement && depth < 8) {
        scores.set(cur, (scores.get(cur) || 0) + len);
        cur = cur.parentElement;
        depth++;
      }
    }
    let best = document.body;
    let bestScore = -1;
    for (const [el, score] of scores) {
      if (el === document.body) continue;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return bestScore > 0 ? best : document.body;
  }

  // ===========================================================================
  // 4. SENTENCE EXTRACTION (DOM Range based)
  // ===========================================================================
  // A SentenceRecord: { id, text, range, blockEl, order, score, selected,
  //                      discovered, summary, highlightSpans }
  let sentenceOrderCounter = 0;
  const allSentences = []; // flat list in document order
  const processedBlocks = new WeakSet();

  function collectTextNodesWithOffsets(blockEl) {
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_SKIP;
        }
        if (isExcluded(node.parentElement)) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let concatenated = "";
    let n;
    while ((n = walker.nextNode())) {
      const start = concatenated.length;
      concatenated += n.nodeValue;
      // Add a space between adjacent text nodes from different inline
      // elements so words don't glue together across tag boundaries.
      nodes.push({ node: n, start, end: concatenated.length });
    }
    return { nodes, concatenated };
  }

  function mapIndexToNode(nodes, index) {
    for (const entry of nodes) {
      if (index >= entry.start && index <= entry.end) {
        return { node: entry.node, offset: index - entry.start };
      }
    }
    const last = nodes[nodes.length - 1];
    return last ? { node: last.node, offset: last.node.length } : null;
  }

  // Splits on Latin sentence punctuation (.!?) the same way as before - that
  // branch requires a following space/quote/end-of-string so it doesn't
  // break on things like "3.14" or "Mr." mid-sentence. CJK text (e.g. 。！？)
  // has no such abbreviation ambiguity and conventionally has no space after
  // the terminator at all, so that branch splits on the punctuation alone
  // with no lookahead required - without this, a page written in Chinese
  // (common on Hong Kong gov/news sites) would never split into sentences
  // and every paragraph would be treated as one giant "sentence", which
  // then gets penalized by the length-based scoring rules and never gets
  // selected as a key sentence.
  const SENTENCE_SPLIT_RE =
    /[^.!?。！？]+[.!?]+(?=\s|["')\]]|$)|[^.!?。！？]+[。！？]+|[^.!?。！？]+$/g;

  function extractSentencesFromBlock(blockEl) {
    const { nodes, concatenated } = collectTextNodesWithOffsets(blockEl);
    if (!nodes.length) return [];
    const results = [];
    let m;
    SENTENCE_SPLIT_RE.lastIndex = 0;
    while ((m = SENTENCE_SPLIT_RE.exec(concatenated))) {
      const raw = m[0];
      const trimmed = raw.trim();
      if (trimmed.length < 8) continue; // too short to be meaningful
      const leading = raw.length - raw.trimStart().length;
      const startIdx = m.index + leading;
      const endIdx = startIdx + trimmed.length;

      const startMap = mapIndexToNode(nodes, startIdx);
      const endMap = mapIndexToNode(nodes, endIdx);
      if (!startMap || !endMap) continue;

      let range;
      try {
        range = document.createRange();
        range.setStart(startMap.node, startMap.offset);
        range.setEnd(endMap.node, endMap.offset);
      } catch (_e) {
        continue;
      }
      if (range.collapsed) continue;

      results.push({
        id: "s" + sentenceOrderCounter,
        text: trimmed,
        range,
        blockEl,
        order: sentenceOrderCounter++,
        score: 0,
        selected: false,
        discovered: false,
        summary: null,
        highlightSpans: [],
      });
    }
    return results;
  }

  function scanForNewBlocks(contentRoot) {
    const blocks = Array.from(contentRoot.querySelectorAll(BLOCK_SELECTOR));
    const blockSet = new Set(blocks);
    const fresh = [];
    for (const block of blocks) {
      if (processedBlocks.has(block)) continue;
      if (isExcluded(block)) continue;
      if (textLengthOf(block) < 15) continue;
      if (isNestedInsideAnotherBlock(block, blockSet)) continue;
      processedBlocks.add(block);
      fresh.push(block);
    }
    const newSentences = [];
    for (const block of fresh) {
      newSentences.push(...extractSentencesFromBlock(block));
    }
    return newSentences;
  }

  // ===========================================================================
  // 5. SENTENCE SCORING + KEY-SENTENCE SELECTION
  // ===========================================================================
  function scoreSentence(text) {
    let score = 0;
    if (/\d/.test(text)) score += 2;
    if (/[%$€]|\bmillion\b|\bbillion\b/i.test(text)) score += 2;

    // Deliberate interpretation (judgment call): the spec lists a bag of
    // "important words" worth +1.5; we treat this as a flat bonus applied
    // once per sentence (not stacked per matching word) to avoid runaway
    // scores on sentences that happen to contain several of them.
    const importantRe = new RegExp(
      "\\b(" + IMPORTANT_WORDS.join("|") + ")\\b",
      "i"
    );
    if (importantRe.test(text)) score += 1.5;

    // Capitalized "proper name" words, excluding the sentence-initial word
    // (which is capitalized merely by grammar, not because it's a name).
    const words = text.split(/\s+/);
    let properCount = 0;
    for (let i = 1; i < words.length; i++) {
      if (/^[A-Z][a-z]+$/.test(words[i])) properCount++;
    }
    score += Math.min(2, properCount * 0.3);

    if (text.length < 40) score -= 2;
    if (text.length > 260) score -= 2;

    return score;
  }

  function selectKeySentences(pool, alreadySelectedCount) {
    // pool: sentences not yet considered for selection (score fresh ones).
    for (const s of pool) s.score = scoreSentence(s.text);

    const totalCandidates = allSentences.length;
    let targetTotal = Math.round(totalCandidates * CFG.TOP_FRACTION);
    targetTotal = Math.max(
      Math.min(CFG.KEY_SENTENCE_MIN, totalCandidates),
      targetTotal
    );
    targetTotal = Math.min(CFG.KEY_SENTENCE_MAX, targetTotal);

    const remainingSlots = targetTotal - alreadySelectedCount;
    if (remainingSlots <= 0) return [];

    const sorted = pool
      .filter((s) => !s.selected)
      .sort((a, b) => b.score - a.score || a.order - b.order);

    // Distribute across paragraphs: cap picks per block on the first pass.
    const blockGroups = new Map();
    for (const s of sorted) {
      if (!blockGroups.has(s.blockEl)) blockGroups.set(s.blockEl, 0);
    }
    const numBlocks = Math.max(1, blockGroups.size);
    const maxPerBlock = Math.max(2, Math.ceil(remainingSlots / numBlocks) + 1);

    const picked = [];
    for (const s of sorted) {
      if (picked.length >= remainingSlots) break;
      const count = blockGroups.get(s.blockEl) || 0;
      if (count < maxPerBlock) {
        picked.push(s);
        blockGroups.set(s.blockEl, count + 1);
      }
    }
    if (picked.length < remainingSlots) {
      for (const s of sorted) {
        if (picked.length >= remainingSlots) break;
        if (!picked.includes(s)) picked.push(s);
      }
    }
    for (const s of picked) s.selected = true;
    return picked.sort((a, b) => a.order - b.order);
  }

  // ===========================================================================
  // 6. SUMMARIZATION
  // ===========================================================================
  let hasApiKey = false;

  function fallbackSummarize(text) {
    let words = text.replace(/\s+/g, " ").trim().split(" ");
    // Strip a leading filler opener ("According to", "However", ...).
    if (
      words.length > 2 &&
      words[0].toLowerCase() === "according" &&
      words[1] &&
      words[1].toLowerCase() === "to"
    ) {
      words = words.slice(2);
    } else if (words.length > 1 && FILLER_OPENERS.includes(words[0].toLowerCase().replace(/[,.]$/, ""))) {
      words = words.slice(1);
    }
    words = words.map((w) => w.replace(/^[,;:]+/, ""));
    let truncated = false;
    if (words.length > CFG.SUMMARY_MAX_WORDS) {
      words = words.slice(0, CFG.SUMMARY_MAX_WORDS);
      truncated = true;
    }
    let out = words.join(" ").trim();
    out = out.replace(/[.,;:]+$/, "");
    if (truncated) out += "…";
    return out || text.slice(0, 40);
  }

  // queueForSummary/flushSummaryQueue/applySummary moved into the
  // isTopFrame block below (they call panel.updateItem(), and panel only
  // exists there) - capWords stays here since runIframeReporterMode also
  // needs it and has no panel to worry about.
  function capWords(text) {
    const words = text.trim().split(/\s+/);
    if (words.length <= CFG.SUMMARY_MAX_WORDS) return text.trim();
    return words.slice(0, CFG.SUMMARY_MAX_WORDS).join(" ") + "…";
  }

  // Section 7 (MutationObserver for dynamic content) lives inside the
  // isTopFrame block below for the same reason as the summarization cluster
  // above: onDebouncedMutation() touches `panel`, which only exists there.
  // runIframeReporterMode has no need for it (no re-scan of dynamic iframe
  // content, by design - see its comment).

  // Everything from here down (canvas, spider, panel, crawling loop) is
  // top-frame-only UI. Wrapped in one block so none of it ever runs inside
  // an injected iframe (which would otherwise create a second, overlapping
  // spider+panel per iframe on the page).
  if (isTopFrame) {
  // ===========================================================================
  // 7. MUTATION OBSERVER (dynamic content) - top-frame only, see note above
  // ===========================================================================
  let mutationTimer = null;
  let contentRoot = null;
  let observer = null;

  function isOwnMutation(node) {
    if (!(node instanceof Element)) {
      node = node && node.parentElement;
    }
    if (!node) return false;
    return Boolean(
      node.closest &&
        node.closest("[data-tldr-glitch],[data-tldr-highlight],[data-tldr-crawler-ui]")
    );
  }

  function setupMutationObserver() {
    observer = new MutationObserver((records) => {
      let relevant = false;
      for (const rec of records) {
        const nodes = [...rec.addedNodes, ...rec.removedNodes];
        if (rec.type === "childList" && nodes.length) {
          const allOwn = nodes.every((n) => isOwnMutation(n));
          if (!allOwn) {
            relevant = true;
            break;
          }
        } else if (rec.type === "characterData") {
          if (!isOwnMutation(rec.target)) {
            relevant = true;
            break;
          }
        }
      }
      if (!relevant) return;
      if (mutationTimer) clearTimeout(mutationTimer);
      mutationTimer = setTimeout(onDebouncedMutation, CFG.MUTATION_DEBOUNCE_MS);
    });
    observer.observe(contentRoot, { childList: true, subtree: true, characterData: true });
    track(() => observer.disconnect());
  }

  function onDebouncedMutation() {
    mutationTimer = null;
    if (!contentRoot || !contentRoot.isConnected) return;
    const fresh = scanForNewBlocks(contentRoot);
    if (!fresh.length) return;
    allSentences.push(...fresh);
    const selectedBefore = allSentences.filter((s) => s.selected).length;
    const picked = selectKeySentences(fresh, selectedBefore);
    panel.setTotal(allSentences.filter((s) => s.selected).length);
    keySentences.push(...picked);
    keySentences.sort((a, b) => a.order - b.order);
  }

  // Summary application for the interactive top-frame flow - moved inside
  // this block because applySummary() touches `panel`, which is declared
  // further down in this same block (section 8). A function defined OUTSIDE
  // this block cannot see a `const` declared INSIDE it no matter where it's
  // later called from - that mismatch was the cause of a "panel is not
  // defined" crash the first time any sentence got discovered.
  let pendingSummaryQueue = [];
  let summaryFlushTimer = null;

  function queueForSummary(sentence) {
    pendingSummaryQueue.push(sentence);
    if (summaryFlushTimer) clearTimeout(summaryFlushTimer);
    summaryFlushTimer = setTimeout(flushSummaryQueue, CFG.SUMMARY_BATCH_DEBOUNCE_MS);
  }

  async function flushSummaryQueue() {
    const batch = pendingSummaryQueue;
    pendingSummaryQueue = [];
    summaryFlushTimer = null;
    if (!batch.length) return;

    if (!hasApiKey) {
      for (const s of batch) applySummary(s, fallbackSummarize(s.text));
      return;
    }

    try {
      const resp = await chrome.runtime.sendMessage({
        type: "tldr:summarizeBatch",
        payload: { sentences: batch.map((s) => ({ id: s.id, text: s.text })) },
      });
      if (resp && resp.ok && Array.isArray(resp.summaries)) {
        const byId = new Map(resp.summaries.map((r) => [r.id, r.summary]));
        for (const s of batch) {
          const sum = byId.get(s.id);
          applySummary(
            s,
            sum && sum.trim() ? capWords(sum) : fallbackSummarize(s.text)
          );
        }
      } else {
        // API unavailable / failed -> never stop the crawler, use fallback.
        for (const s of batch) applySummary(s, fallbackSummarize(s.text));
      }
    } catch (_e) {
      for (const s of batch) applySummary(s, fallbackSummarize(s.text));
    }
  }

  function applySummary(sentence, summaryText) {
    sentence.summary = summaryText;
    panel.updateItem(sentence);
  }

  // ===========================================================================
  // 8. SHADOW DOM UI HOST
  // ===========================================================================
  const uiHost = document.createElement("div");
  uiHost.setAttribute("data-tldr-crawler-ui", "1");
  // z-index must be set HERE, on the host itself, not just on the canvas/
  // panel inside its shadow root. A shadow host's children's z-index values
  // only compete against each OTHER inside the host's own stacking context;
  // the host element competes against the page's OTHER top-level positioned
  // elements using ITS OWN z-index. Without this, a z-index:auto host loses
  // to any ordinary page element that happens to set e.g. z-index:999 (very
  // common for sticky headers/search bars), silently burying the entire
  // spider+panel UI beneath normal page content despite the sky-high
  // z-index set on the canvas/panel internally.
  uiHost.style.cssText =
    "all: initial; position: fixed; top:0; left:0; width:0; height:0; z-index: 2147483647;";
  const shadow = uiHost.attachShadow({ mode: "open" });
  document.documentElement.appendChild(uiHost);
  track(() => uiHost.remove());

  const shadowStyle = document.createElement("style");
  shadowStyle.textContent = `
    :host { all: initial; }
    canvas#tldr-canvas {
      position: fixed;
      top: 0; left: 0;
      width: 100vw; height: 100vh;
      pointer-events: none;
      z-index: 2147483646;
    }
    #tldr-panel {
      position: fixed;
      top: 16px;
      right: 16px;
      width: 300px;
      max-height: 70vh;
      background: #16181c;
      color: #e8ebf0;
      border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.45);
      font-family: Arial, Helvetica, sans-serif;
      font-size: 12.5px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      pointer-events: auto;
    }
    #tldr-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      cursor: grab;
      background: #1c1f26;
      user-select: none;
    }
    #tldr-header.dragging { cursor: grabbing; }
    #tldr-title {
      font-family: "Courier New", Consolas, monospace;
      color: #ffd166;
      font-weight: bold;
      letter-spacing: 1px;
    }
    #tldr-close-x {
      background: none;
      border: none;
      color: #9aa3b2;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 2px 4px;
    }
    #tldr-close-x:hover { color: #ff4f7a; }
    #tldr-progress-row {
      padding: 6px 12px 0;
      font-size: 11px;
      color: #9aa3b2;
    }
    #tldr-progress-track {
      margin: 6px 12px 8px;
      height: 6px;
      border-radius: 4px;
      background: #262b36;
      overflow: hidden;
    }
    #tldr-progress-fill {
      height: 100%;
      width: 0%;
      background: #ff4f7a;
      transition: width 0.25s ease-out;
    }
    #tldr-list {
      list-style: none;
      margin: 0;
      padding: 4px 12px 8px;
      overflow-y: auto;
      flex: 1 1 auto;
      min-height: 40px;
    }
    #tldr-list li {
      padding: 6px 8px;
      margin-bottom: 4px;
      border-radius: 6px;
      background: #1b1e26;
      line-height: 1.4;
      transition: background-color 0.4s ease;
    }
    #tldr-list li.flash {
      background-color: #4d4420;
    }
    #tldr-list li .n {
      color: #5ab8ff;
      font-weight: bold;
      margin-right: 6px;
    }
    #tldr-empty {
      color: #6b7280;
      padding: 8px;
      font-style: italic;
    }
    #tldr-ai-block {
      padding: 8px 12px;
      border-top: 1px solid #262b36;
      color: #cdd5e0;
      font-size: 12px;
      white-space: pre-line;
    }
    .hidden { display: none !important; }
    #tldr-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px 12px 12px;
      border-top: 1px solid #262b36;
    }
    #tldr-buttons button {
      flex: 1 1 auto;
      background: #262b36;
      color: #e8ebf0;
      border: 1px solid #333a48;
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
    }
    #tldr-buttons button:hover { filter: brightness(1.2); }
    #tldr-buttons button.primary { background: #5ab8ff; color: #0f1115; border-color: #5ab8ff; font-weight: 600; }
    #tldr-buttons button.danger { color: #ff4f7a; }
    #tldr-scroll-wrap {
      display: flex;
      flex-direction: column;
      min-height: 0;
      flex: 1 1 auto;
    }
  `;
  shadow.appendChild(shadowStyle);

  const canvas = document.createElement("canvas");
  canvas.id = "tldr-canvas";
  shadow.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeCanvas();
  addListener(window, "resize", resizeCanvas);

  // ---- Panel markup -----------------------------------------------------
  const panelEl = document.createElement("div");
  panelEl.id = "tldr-panel";
  panelEl.innerHTML = `
    <div id="tldr-header">
      <span id="tldr-title">TL;DR</span>
      <button id="tldr-close-x" title="關閉" aria-label="關閉">✕</button>
    </div>
    <div id="tldr-progress-row"><span id="tldr-progress-text">搵到 0 / 0</span></div>
    <div id="tldr-progress-track"><div id="tldr-progress-fill"></div></div>
    <div id="tldr-scroll-wrap">
      <ol id="tldr-list"></ol>
    </div>
    <div id="tldr-ai-block" class="hidden"></div>
    <div id="tldr-buttons">
      <button id="tldr-copy">複製 TL;DR</button>
      <button id="tldr-restart">重新開始</button>
      <button id="tldr-write-ai" class="primary hidden">用 Claude 寫 TL;DR</button>
      <button id="tldr-close" class="danger">關閉</button>
    </div>
  `;
  shadow.appendChild(panelEl);

  const listEl = shadow.getElementById("tldr-list");
  const progressTextEl = shadow.getElementById("tldr-progress-text");
  const progressFillEl = shadow.getElementById("tldr-progress-fill");
  const aiBlockEl = shadow.getElementById("tldr-ai-block");
  const writeAiBtn = shadow.getElementById("tldr-write-ai");

  const panel = {
    total: 0,
    setTotal(n) {
      this.total = n;
      this.refreshProgress();
    },
    refreshProgress() {
      const found = keySentences.filter((s) => s.discovered).length;
      progressTextEl.textContent = `搵到 ${found} / ${this.total}`;
      const pct = this.total ? Math.min(100, (found / this.total) * 100) : 0;
      progressFillEl.style.width = pct + "%";
    },
    render() {
      listEl.innerHTML = "";
      const discovered = keySentences.filter((s) => s.discovered).sort((a, b) => a.order - b.order);
      if (!discovered.length) {
        const li = document.createElement("li");
        li.id = "tldr-empty";
        li.textContent = "將個滑鼠移去篇文章度,等蜘蛛開始爬文…";
        listEl.appendChild(li);
        return;
      }
      discovered.forEach((s, i) => {
        const li = document.createElement("li");
        li.dataset.sentenceId = s.id;
        const n = document.createElement("span");
        n.className = "n";
        n.textContent = i + 1 + ".";
        const txt = document.createElement("span");
        txt.textContent = s.summary || "…";
        li.appendChild(n);
        li.appendChild(txt);
        listEl.appendChild(li);
      });
      this.refreshProgress();
    },
    updateItem(sentence) {
      this.render();
      const li = listEl.querySelector(`li[data-sentence-id="${sentence.id}"]`);
      if (li) {
        li.classList.add("flash");
        setTimeout(() => li.classList.remove("flash"), reducedMotion ? 0 : 900);
        li.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
      }
    },
    showAiThinking() {
      aiBlockEl.classList.remove("hidden");
      aiBlockEl.textContent = "諗緊…";
    },
    showAiResult(lines) {
      aiBlockEl.classList.remove("hidden");
      aiBlockEl.textContent = lines.map((l) => "• " + l).join("\n");
    },
    showAiError() {
      aiBlockEl.classList.remove("hidden");
      aiBlockEl.textContent = "AI 用唔到";
      setTimeout(() => {
        if (aiBlockEl.textContent === "AI 用唔到") aiBlockEl.classList.add("hidden");
      }, 4000);
    },
  };

  // ===========================================================================
  // 9. HIGHLIGHTING
  // ===========================================================================
  const HIGHLIGHT_NAME = "tldr-found";
  const supportsCustomHighlight = Boolean(window.Highlight && CSS.highlights);
  let highlightObj = null;
  if (supportsCustomHighlight) {
    highlightObj = new Highlight();
    CSS.highlights.set(HIGHLIGHT_NAME, highlightObj);
  }

  const pageStyle = document.createElement("style");
  pageStyle.setAttribute("data-tldr-crawler-ui", "1");
  pageStyle.textContent = `
    ::highlight(${HIGHLIGHT_NAME}) { background-color: rgba(255, 221, 102, 0.55); }
    .tldr-fallback-highlight { background-color: rgba(255, 221, 102, 0.55); border-radius: 2px; }
    .tldr-glitch-mono { font-family: "Courier New", Consolas, monospace !important; }
    .tldr-glitch-outline { outline: 1px solid #5ab8ff; outline-offset: 1px; border-radius: 2px; }
    .tldr-glitch-bg { background-color: rgba(90, 184, 255, 0.35); border-radius: 2px; }
    .tldr-glitch-rotate { display: inline-block; transform: rotate(-4deg); }
    .tldr-glitch-spacing { letter-spacing: 2px; }
    .tldr-glitch-blur { filter: blur(0.6px); }
    .tldr-glitch-upper { text-transform: uppercase; }
  `;
  document.head.appendChild(pageStyle);
  track(() => pageStyle.remove());

  function highlightSentence(sentence) {
    if (supportsCustomHighlight) {
      try {
        // Keep a reference to the exact Range instance we add: Highlight is
        // an identity-keyed set, so delete() later must pass this same
        // object (adding sentence.range directly, not a clone, so there is
        // only ever one reference to track and remove).
        highlightObj.add(sentence.range);
        return;
      } catch (_e) {
        // fall through to manual wrapping fallback
      }
    }
    // Fallback: wrap each intersecting text-node fragment individually so
    // we never destroy existing inline elements or merge sentence text
    // into one new container element.
    const root = sentence.range.commonAncestorContainer;
    const containerEl = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
    if (!containerEl) return;
    const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT);
    const targets = [];
    let node = walker.nextNode();
    while (node) {
      if (sentence.range.intersectsNode(node)) {
        const start = node === sentence.range.startContainer ? sentence.range.startOffset : 0;
        const end = node === sentence.range.endContainer ? sentence.range.endOffset : node.length;
        if (end > start) targets.push({ node, start, end });
      }
      node = walker.nextNode();
    }
    for (const t of targets) {
      const span = wrapTextRange(t.node, t.start, t.end, "tldr-fallback-highlight", "data-tldr-highlight");
      if (span) sentence.highlightSpans.push(span);
    }
  }

  function removeSentenceHighlight(sentence) {
    if (supportsCustomHighlight && highlightObj) {
      try {
        highlightObj.delete(sentence.range);
      } catch (_e) {
        /* ignore */
      }
    }
    for (const span of sentence.highlightSpans) {
      if (span.isConnected) unwrapSpan(span);
      const idx = createdSpans.indexOf(span);
      if (idx !== -1) createdSpans.splice(idx, 1);
    }
    sentence.highlightSpans = [];
  }

  // Splits a text node so [start,end) becomes its own node, wraps it in a
  // new <span>, and returns that span. Safe because surroundContents-style
  // operations are avoided entirely; we just move one already-isolated
  // text node into a new parent.
  function wrapTextRange(textNode, start, end, className, dataAttr) {
    if (!textNode || !textNode.parentNode) return null;
    try {
      let target = textNode;
      if (start > 0) target = target.splitText(start);
      if (end - start < target.length) target.splitText(end - start);
      const span = document.createElement("span");
      span.className = className;
      if (dataAttr) span.setAttribute(dataAttr, "1");
      target.parentNode.insertBefore(span, target);
      span.appendChild(target);
      createdSpans.push(span);
      return span;
    } catch (_e) {
      return null;
    }
  }

  // ===========================================================================
  // 10. WORD GLITCH EFFECTS
  // ===========================================================================
  const GLITCH_CLASSES = [
    "tldr-glitch-mono",
    "tldr-glitch-outline",
    "tldr-glitch-bg",
    "tldr-glitch-rotate",
    "tldr-glitch-spacing",
    "tldr-glitch-blur",
    "tldr-glitch-upper",
  ];

  function tryGlitchAt(range) {
    if (reducedMotion) return;
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return;
    const node = range.startContainer;
    const parentEl = node.parentElement;
    if (!parentEl) return;
    if (!contentRoot || !contentRoot.contains(parentEl)) return;
    if (isExcluded(parentEl)) return;
    if (parentEl.closest("[data-tldr-glitch]")) return; // already glitched

    const text = node.nodeValue;
    const offset = Math.min(range.startOffset, text.length - 1);
    if (offset < 0) return;
    const isWordChar = (c) => /[A-Za-z0-9'-]/.test(c);
    if (!isWordChar(text[offset])) return;

    let start = offset;
    while (start > 0 && isWordChar(text[start - 1])) start--;
    let end = offset;
    while (end < text.length && isWordChar(text[end])) end++;
    const word = text.slice(start, end);
    if (word.length < 2) return;

    if (Math.random() >= CFG.GLITCH_CHANCE) return;

    const span = wrapTextRange(node, start, end, "", "data-tldr-glitch");
    if (!span) return;
    const shuffled = [...GLITCH_CLASSES].sort(() => Math.random() - 0.5);
    const count = Math.random() < 0.5 ? 1 : 2;
    span.className = shuffled.slice(0, count).join(" ");
  }

  // ===========================================================================
  // 11. SPIDER PHYSICS + IK + RENDERING
  // ===========================================================================
  const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2, lastMoveTime: performance.now() };
  addListener(
    document,
    "mousemove",
    (e) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.lastMoveTime = performance.now();
    },
    { capture: true, passive: true }
  );

  const LEG_DEFS = [
    { side: -1, along: -14 },
    { side: -1, along: -2 },
    { side: -1, along: 10 },
    { side: -1, along: 20 },
    { side: 1, along: -14 },
    { side: 1, along: -2 },
    { side: 1, along: 10 },
    { side: 1, along: 20 },
  ];

  function rotateVec(x, y, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return { x: x * c - y * s, y: x * s + y * c };
  }

  const spider = {
    x: mouse.x,
    y: mouse.y,
    vx: 0,
    vy: 0,
    angle: 0,
    mode: "follow",
    wanderTarget: { x: mouse.x, y: mouse.y },
    nextWanderPickTime: 0,
    legs: LEG_DEFS.map((def, i) => {
      const hipLocal = { x: def.along, y: def.side * CFG.BODY_WIDTH };
      const idealLocal = { x: def.along, y: def.side * (CFG.BODY_WIDTH + CFG.THIGH_LEN + CFG.SHIN_LEN - 6) };
      return {
        def,
        group: i % 2,
        hipLocal,
        idealLocal,
        foot: { x: 0, y: 0 },
        stepping: false,
        stepT: 0,
        stepFrom: { x: 0, y: 0 },
        stepTo: { x: 0, y: 0 },
      };
    }),
  };
  // initialize feet to resting world positions
  for (const leg of spider.legs) {
    const world = rotateVec(leg.idealLocal.x, leg.idealLocal.y, spider.angle);
    leg.foot.x = spider.x + world.x;
    leg.foot.y = spider.y + world.y;
  }

  function solveTwoBoneIK(hip, foot, l1, l2, bendSign) {
    let dx = foot.x - hip.x;
    let dy = foot.y - hip.y;
    let d = Math.hypot(dx, dy) || 0.0001;
    const maxReach = l1 + l2 - 0.5;
    const minReach = Math.abs(l1 - l2) + 0.5;
    if (d > maxReach) {
      dx = (dx / d) * maxReach;
      dy = (dy / d) * maxReach;
      d = maxReach;
    } else if (d < minReach) {
      d = minReach;
    }
    const cosA = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
    const a = Math.acos(cosA);
    const base = Math.atan2(dy, dx);
    const kneeAngle = base + bendSign * a;
    return {
      x: hip.x + Math.cos(kneeAngle) * l1,
      y: hip.y + Math.sin(kneeAngle) * l1,
    };
  }

  let lastFrameTime = performance.now();
  let physicsAccumulator = 0;
  let rafHandle = null;
  let lastScanTime = 0;

  // While wandering, aim at an undiscovered key sentence that's actually
  // within the current viewport (the extension already knows exactly where
  // these are via each sentence's Range) rather than picking a pure uniform-
  // random point - a fully random walk across a large viewport can easily
  // take minutes of luck to ever cross the handful of narrow text lines
  // that still matter. Falls back to the old random-point behavior when
  // there's nothing left to find on-screen (e.g. everything visible is
  // already discovered, or the remaining sentences are below the fold).
  function pickWanderTarget() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const candidates = [];
    for (const s of keySentences) {
      if (s.discovered || !s.range) continue;
      let rect;
      try {
        rect = s.range.getBoundingClientRect();
      } catch (_e) {
        continue;
      }
      if (rect.width <= 0 && rect.height <= 0) continue;
      // Only consider sentences at least mostly inside the visible viewport.
      if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
      candidates.push(rect);
    }
    if (candidates.length) {
      const rect = candidates[Math.floor(Math.random() * candidates.length)];
      // Small jitter so it doesn't always aim at the exact same pixel of a
      // given line, and clamp into the same safe margin as the random case.
      const jitterX = (Math.random() - 0.5) * Math.min(40, rect.width);
      const jitterY = (Math.random() - 0.5) * Math.min(10, rect.height);
      return {
        x: Math.min(Math.max(20, rect.x + rect.width / 2 + jitterX), vw - 20),
        y: Math.min(Math.max(20, rect.y + rect.height / 2 + jitterY), vh - 20),
      };
    }
    return {
      x: 60 + Math.random() * Math.max(1, vw - 120),
      y: 60 + Math.random() * Math.max(1, vh - 120),
    };
  }

  function stepPhysics(dt) {
    const now = performance.now();
    const idleMs = now - mouse.lastMoveTime;
    const speedScale = reducedMotion ? 0.45 : 1;

    if (idleMs > CFG.WANDER_IDLE_MS) {
      spider.mode = "wander";
      if (now > spider.nextWanderPickTime) {
        spider.wanderTarget = pickWanderTarget();
        spider.nextWanderPickTime = now + 2500 + Math.random() * 2500;
      }
    } else {
      spider.mode = "follow";
    }

    const target = spider.mode === "follow" ? mouse : spider.wanderTarget;
    const dx = target.x - spider.x;
    const dy = target.y - spider.y;
    const dist = Math.hypot(dx, dy);

    const maxSpeed = CFG.MAX_SPEED * speedScale;
    let desiredSpeed = 0;
    if (dist > CFG.STOP_DISTANCE) {
      // ease speed down as we approach the stop radius
      const overshoot = Math.min(1, (dist - CFG.STOP_DISTANCE) / 120);
      desiredSpeed = maxSpeed * (0.25 + 0.75 * overshoot);
    }
    const dirX = dist > 0.001 ? dx / dist : 0;
    const dirY = dist > 0.001 ? dy / dist : 0;
    const desiredVx = dirX * desiredSpeed;
    const desiredVy = dirY * desiredSpeed;

    // smooth acceleration/deceleration
    const accel = 6; // responsiveness factor
    spider.vx += (desiredVx - spider.vx) * Math.min(1, accel * dt);
    spider.vy += (desiredVy - spider.vy) * Math.min(1, accel * dt);
    spider.x += spider.vx * dt;
    spider.y += spider.vy * dt;

    const movingSpeed = Math.hypot(spider.vx, spider.vy);
    if (movingSpeed > 5) {
      const targetAngle = Math.atan2(spider.vy, spider.vx);
      let delta = targetAngle - spider.angle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      spider.angle += delta * Math.min(1, 8 * dt);
    }

    // Leg stepping
    for (const leg of spider.legs) {
      const world = rotateVec(leg.idealLocal.x, leg.idealLocal.y, spider.angle);
      const idealX = spider.x + world.x;
      const idealY = spider.y + world.y;

      if (leg.stepping) {
        leg.stepT += dt / CFG.STEP_DURATION;
        if (leg.stepT >= 1) {
          leg.stepT = 1;
          leg.stepping = false;
          leg.foot.x = leg.stepTo.x;
          leg.foot.y = leg.stepTo.y;
        } else {
          const t = leg.stepT;
          const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // smoothstep-ish
          leg.foot.x = leg.stepFrom.x + (leg.stepTo.x - leg.stepFrom.x) * ease;
          leg.foot.y = leg.stepFrom.y + (leg.stepTo.y - leg.stepFrom.y) * ease;
        }
      } else {
        const fdx = idealX - leg.foot.x;
        const fdy = idealY - leg.foot.y;
        const fdist = Math.hypot(fdx, fdy);
        const oppositeGroupStepping = spider.legs.some(
          (other) => other.group !== leg.group && other.stepping
        );
        if (fdist > CFG.FOOT_STEP_TRIGGER_DIST && !oppositeGroupStepping) {
          leg.stepping = true;
          leg.stepT = 0;
          leg.stepFrom = { x: leg.foot.x, y: leg.foot.y };
          // land slightly ahead in the walking direction
          const lead = {
            x: idealX + dirX * 10,
            y: idealY + dirY * 10,
          };
          leg.stepTo = lead;
          lastScanTime = 0; // force an immediate crawl scan on footfall
        }
      }
    }
  }

  function drawSpider() {
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    ctx.save();
    ctx.strokeStyle = "#5ab8ff";
    ctx.fillStyle = "#5ab8ff";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";

    // Legs (drawn first, body on top of leg roots)
    for (const leg of spider.legs) {
      const hipWorld = (() => {
        const w = rotateVec(leg.hipLocal.x, leg.hipLocal.y, spider.angle);
        return { x: spider.x + w.x, y: spider.y + w.y };
      })();
      const bendSign = leg.def.side;
      const knee = solveTwoBoneIK(hipWorld, leg.foot, CFG.THIGH_LEN, CFG.SHIN_LEN, bendSign);

      let footDraw = leg.foot;
      if (leg.stepping) {
        const lift = Math.sin(Math.PI * leg.stepT) * CFG.FOOT_LIFT_PX * (reducedMotion ? 0.3 : 1);
        footDraw = { x: leg.foot.x, y: leg.foot.y - lift };
      }

      ctx.beginPath();
      ctx.moveTo(hipWorld.x, hipWorld.y);
      ctx.lineTo(knee.x, knee.y);
      ctx.lineTo(footDraw.x, footDraw.y);
      ctx.stroke();

      ctx.fillStyle = "#ff4f7a";
      ctx.beginPath();
      ctx.arc(knee.x, knee.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(footDraw.x, footDraw.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#5ab8ff";
    }

    // Abdomen (ellipse behind the body)
    const abdomenWorld = rotateVec(-CFG.BODY_LENGTH * 0.9, 0, spider.angle);
    ctx.save();
    ctx.translate(spider.x + abdomenWorld.x, spider.y + abdomenWorld.y);
    ctx.rotate(spider.angle);
    ctx.beginPath();
    ctx.ellipse(0, 0, 13, 9, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Body (rounded rectangle)
    ctx.save();
    ctx.translate(spider.x, spider.y);
    ctx.rotate(spider.angle);
    roundRectPath(ctx, -10, -7, 20, 14, 5);
    ctx.stroke();
    ctx.restore();

    // Head with two white eyes
    const headWorld = rotateVec(CFG.BODY_LENGTH * 0.55, 0, spider.angle);
    ctx.save();
    ctx.translate(spider.x + headWorld.x, spider.y + headWorld.y);
    ctx.rotate(spider.angle);
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(2, -2.4, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(2, 2.4, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function rafLoop(now) {
    // Another injection may have claimed the shared generation token (i.e.
    // this exact instance was just asked to turn off) - stop scheduling
    // further frames and run our own cleanup. Checked first, every frame,
    // so a toggle-off takes effect within one frame regardless of which
    // isolated world actually receives the next click.
    let stillCurrent = true;
    try {
      stillCurrent = sessionStorage.getItem(TLDR_SESSION_KEY) === tldrGeneration;
    } catch (_e) {
      stillCurrent = true; // storage blocked - can't detect takeover, just keep running
    }
    if (!stillCurrent) {
      shutdown();
      return;
    }
    rafHandle = requestAnimationFrame(rafLoop);
    let dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    if (dt > 0.25) dt = 0.25; // clamp huge gaps (tab backgrounded, etc.)
    physicsAccumulator += dt;
    let steps = 0;
    while (physicsAccumulator >= CFG.PHYSICS_STEP && steps < 10) {
      stepPhysics(CFG.PHYSICS_STEP);
      physicsAccumulator -= CFG.PHYSICS_STEP;
      steps++;
    }
    drawSpider();

    if (now - lastScanTime >= CFG.SCAN_INTERVAL_MS) {
      lastScanTime = now;
      scanForText();
    }
  }

  // ===========================================================================
  // 12. CRAWLING / TEXT-DETECTION LOOP
  // ===========================================================================
  let keySentences = []; // subset of allSentences currently selected as "key"

  function getCaretRangeAt(x, y) {
    if (document.caretRangeFromPoint) {
      return document.caretRangeFromPoint(x, y);
    }
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (!pos) return null;
      const r = document.createRange();
      r.setStart(pos.offsetNode, pos.offset);
      r.setEnd(pos.offsetNode, pos.offset);
      return r;
    }
    return null;
  }

  function scanForText() {
    if (!contentRoot) return;
    // Ignore points over our own UI (shadow host has no hit area, but be safe).
    const el = document.elementFromPoint(spider.x, spider.y);
    if (el && el.closest && el.closest("[data-tldr-crawler-ui]")) return;

    const range = getCaretRangeAt(spider.x, spider.y);
    if (!range) return;

    // Discover key sentences
    for (const s of keySentences) {
      if (s.discovered) continue;
      let hit = false;
      try {
        hit = s.range.isPointInRange(range.startContainer, range.startOffset);
      } catch (_e) {
        hit = false;
      }
      if (hit) {
        s.discovered = true;
        highlightSentence(s);
        queueForSummary(s);
        panel.render();
      }
    }

    // Word glitch (independent of sentence discovery)
    tryGlitchAt(range);
  }

  // ===========================================================================
  // 13. PANEL UI WIRING
  // ===========================================================================
  const headerEl = shadow.getElementById("tldr-header");
  let dragging = false;
  let dragOffset = { x: 0, y: 0 };

  addListener(headerEl, "mousedown", (e) => {
    dragging = true;
    headerEl.classList.add("dragging");
    const rect = panelEl.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;
    panelEl.style.right = "auto";
    e.preventDefault();
  });
  addListener(window, "mousemove", (e) => {
    if (!dragging) return;
    const x = Math.min(Math.max(0, e.clientX - dragOffset.x), window.innerWidth - 40);
    const y = Math.min(Math.max(0, e.clientY - dragOffset.y), window.innerHeight - 40);
    panelEl.style.left = x + "px";
    panelEl.style.top = y + "px";
  });
  addListener(window, "mouseup", () => {
    dragging = false;
    headerEl.classList.remove("dragging");
  });

  shadow.getElementById("tldr-copy").addEventListener("click", copyTldrToClipboard);
  shadow.getElementById("tldr-restart").addEventListener("click", restart);
  shadow.getElementById("tldr-close").addEventListener("click", shutdown);
  shadow.getElementById("tldr-close-x").addEventListener("click", shutdown);
  writeAiBtn.addEventListener("click", writeTldrWithClaude);

  async function copyTldrToClipboard() {
    const discovered = keySentences.filter((s) => s.discovered).sort((a, b) => a.order - b.order);
    const text = discovered.map((s, i) => `${i + 1}. ${s.summary || s.text}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch (_e) {
      // Fallback for pages that block the Clipboard API via Permissions-Policy.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      shadow.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch (_e2) {
        /* ignore */
      }
      ta.remove();
    }
  }

  async function writeTldrWithClaude() {
    const discovered = keySentences.filter((s) => s.discovered).sort((a, b) => a.order - b.order);
    if (!discovered.length) return;
    panel.showAiThinking();
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "tldr:writeTldr",
        payload: { sentences: discovered.map((s) => ({ text: s.text })) },
      });
      if (resp && resp.ok && Array.isArray(resp.lines)) {
        panel.showAiResult(resp.lines);
      } else {
        panel.showAiError();
      }
    } catch (_e) {
      panel.showAiError();
    }
  }

  // ===========================================================================
  // 14. LIFECYCLE
  // ===========================================================================
  function undoAllGlitchesAndHighlights() {
    for (const s of keySentences) removeSentenceHighlight(s);
    // Any remaining glitch spans (not tied to a sentence) still get unwrapped.
    unwrapAllSpans();
  }

  function resetDiscoveryState() {
    for (const s of allSentences) {
      s.discovered = false;
      s.summary = null;
      s.highlightSpans = [];
    }
    pendingSummaryQueue = [];
    if (summaryFlushTimer) {
      clearTimeout(summaryFlushTimer);
      summaryFlushTimer = null;
    }
  }

  function restart() {
    undoAllGlitchesAndHighlights();
    resetDiscoveryState();
    aiBlockEl.classList.add("hidden");
    aiBlockEl.textContent = "";
    panel.render();
    panel.setTotal(keySentences.length);
  }

  function shutdown() {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    if (mutationTimer) clearTimeout(mutationTimer);
    if (summaryFlushTimer) clearTimeout(summaryFlushTimer);
    undoAllGlitchesAndHighlights();
    if (supportsCustomHighlight) {
      try {
        CSS.highlights.delete(HIGHLIGHT_NAME);
      } catch (_e) {
        /* ignore */
      }
    }
    // Run every registered disposer (listeners, observer, injected style,
    // the shadow host itself, resize handler, etc.)
    while (disposables.length) {
      const fn = disposables.pop();
      try {
        fn();
      } catch (_e) {
        /* best-effort cleanup */
      }
    }
    // Compare-and-delete: only clear the token if it's still ours. If this
    // shutdown() was triggered by the generation-mismatch check in rafLoop,
    // a newer instance already claimed/cleared it - don't stomp on that.
    try {
      if (sessionStorage.getItem(TLDR_SESSION_KEY) === tldrGeneration) {
        sessionStorage.removeItem(TLDR_SESSION_KEY);
      }
    } catch (_e) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Receives summarized sentences reported up by same-origin iframes running
  // in runIframeReporterMode (see bottom of file). Origin-checked so only
  // this exact document's own frames' reports are trusted, not arbitrary
  // postMessage traffic from page JS or unrelated frames.
  // ---------------------------------------------------------------------------
  const reportedIframeIds = new Set();
  function onIframeReport(event) {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== "tldr-crawler-iframe" || !Array.isArray(data.sentences)) return;
    let added = false;
    for (const item of data.sentences) {
      if (!item || (typeof item.id !== "string" && typeof item.id !== "number")) continue;
      const key = "iframe:" + item.id;
      if (reportedIframeIds.has(key)) continue;
      reportedIframeIds.add(key);
      const text = String(item.text || "");
      keySentences.push({
        id: key,
        text,
        range: null, // cross-document: no highlightable Range in this document
        blockEl: null,
        order: keySentences.length + 1e6, // keep iframe items after top-frame ones
        score: 0,
        selected: true,
        discovered: true,
        summary: item.summary ? String(item.summary) : fallbackSummarize(text),
        highlightSpans: [],
      });
      added = true;
    }
    if (added) {
      panel.setTotal(keySentences.length);
      panel.render();
    }
  }

  // ---------------------------------------------------------------------------
  // Manual "select text -> right-click -> 加入 TL;DR" fallback (background.js
  // owns the actual context-menu item; this just receives the chosen text).
  // No DOM Range is available for text handed over this way (background.js
  // only gives us the plain string via contextMenus' selectionText), so -
  // same tradeoff as iframe-reported sentences - there's no on-page yellow
  // highlight for these, just a panel entry.
  // ---------------------------------------------------------------------------
  let manualSentenceCounter = 0;
  function onRuntimeMessage(message, _sender, sendResponse) {
    if (!message || message.type !== "tldr:addManualSentence") return false;
    const text = String(message.text || "").trim();
    if (!text) {
      sendResponse({ ok: false });
      return false;
    }
    const sentence = {
      id: "manual:" + manualSentenceCounter++,
      text,
      range: null,
      blockEl: null,
      order: keySentences.length + 2e6, // after automatic + iframe sentences
      score: 0,
      selected: true,
      discovered: true,
      summary: null,
      highlightSpans: [],
    };
    keySentences.push(sentence);
    panel.setTotal(keySentences.length);
    panel.render();
    queueForSummary(sentence);
    sendResponse({ ok: true });
    return false;
  }

  // ===========================================================================
  // STARTUP SEQUENCE
  // ===========================================================================
  function start() {
    contentRoot = findMainContentElement();
    const initial = scanForNewBlocks(contentRoot);
    allSentences.push(...initial);
    keySentences = selectKeySentences(initial, 0);
    panel.setTotal(keySentences.length);
    panel.render();
    window.__tldrDebugSentences = keySentences; // temporary debug hook
    window.__tldrDebugSpider = spider; // temporary debug hook
    window.__tldrDebugMouse = mouse; // temporary debug hook

    setupMutationObserver();
    addListener(window, "message", onIframeReport);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    track(() => chrome.runtime.onMessage.removeListener(onRuntimeMessage));

    chrome.runtime.sendMessage({ type: "tldr:hasApiKey" }, (resp) => {
      // chrome.runtime.lastError can be set if the background worker was
      // asleep and just woke up with no listener race; ignore safely.
      void chrome.runtime.lastError;
      hasApiKey = Boolean(resp && resp.hasKey);
      writeAiBtn.classList.toggle("hidden", !hasApiKey);
    });

    rafHandle = requestAnimationFrame(rafLoop);
  }

  start();
  } else {
    runIframeReporterMode();
  }

  // ===========================================================================
  // IFRAME REPORTER MODE (non-top frames only)
  // ===========================================================================
  // No spider/canvas/panel here - just a best-effort one-time scan of this
  // iframe's own document, summarized and posted up to the top frame's panel.
  // Deliberately simpler than the top-frame flow: no MutationObserver-driven
  // re-scanning of dynamically-added iframe content, since that would need
  // its own debounce/report-delta bookkeeping for comparatively little
  // benefit - most iframes (job-board widgets, embedded listings) render
  // their content once up front rather than infinite-scrolling.
  function runIframeReporterMode() {
    // A genuinely cross-origin iframe would already be unable to read
    // window.top.location (throws SecurityError) - bail out silently rather
    // than attempting anything further against a frame we have no business
    // touching. Also skip tiny iframes (ads/trackers/tracking pixels).
    try {
      void window.top.location.href;
    } catch (_e) {
      return;
    }
    if (window.innerWidth < 200 || window.innerHeight < 150) {
      return;
    }

    const root = findMainContentElement();
    const found = scanForNewBlocks(root);
    allSentences.push(...found);
    const picked = selectKeySentences(found, 0);
    if (!picked.length) return;

    chrome.runtime.sendMessage({ type: "tldr:hasApiKey" }, async (resp) => {
      void chrome.runtime.lastError;
      hasApiKey = Boolean(resp && resp.hasKey);

      let summarized;
      if (!hasApiKey) {
        summarized = picked.map((s) => ({ id: s.id, text: s.text, summary: fallbackSummarize(s.text) }));
      } else {
        try {
          const sumResp = await chrome.runtime.sendMessage({
            type: "tldr:summarizeBatch",
            payload: { sentences: picked.map((s) => ({ id: s.id, text: s.text })) },
          });
          if (sumResp && sumResp.ok && Array.isArray(sumResp.summaries)) {
            const byId = new Map(sumResp.summaries.map((r) => [r.id, r.summary]));
            summarized = picked.map((s) => {
              const sum = byId.get(s.id);
              return {
                id: s.id,
                text: s.text,
                summary: sum && sum.trim() ? capWords(sum) : fallbackSummarize(s.text),
              };
            });
          } else {
            summarized = picked.map((s) => ({ id: s.id, text: s.text, summary: fallbackSummarize(s.text) }));
          }
        } catch (_e) {
          summarized = picked.map((s) => ({ id: s.id, text: s.text, summary: fallbackSummarize(s.text) }));
        }
      }

      // The user may have toggled the crawler off again while this async
      // round-trip was in flight - don't report into a torn-down instance.
      try {
        if (sessionStorage.getItem(TLDR_SESSION_KEY) !== tldrGeneration) return;
      } catch (_e) {
        /* storage blocked - proceed anyway */
      }
      try {
        window.top.postMessage(
          { source: "tldr-crawler-iframe", sentences: summarized },
          window.location.origin
        );
      } catch (_e) {
        /* ignore */
      }
    });
  }
})();
