# TL;DR Crawler

A Chrome (Manifest V3) extension that drops a line-drawn, animated spider onto
the current webpage. The spider follows your cursor (and keeps up while you
scroll), discovers important sentences in the article as it walks over them,
highlights them, occasionally "glitches" a word it steps on, and gradually
assembles a short TL;DR in a floating panel.

## What it does

- Click the toolbar icon to spawn the spider on the current page.
- The spider walks toward your mouse cursor using simple physics and inverse
  kinematics for its eight legs, and wanders the viewport if the cursor is
  idle for a while.
- It automatically finds the page's main readable content (`<article>`,
  `<main>`, or the element with the most paragraph text) and splits it into
  sentences.
- Sentences are scored for "newsworthiness" (numbers, currency/percent
  signs, key words like "first"/"record"/"launch", proper names, sentence
  length) and the top ~25% become "key sentences" the spider can discover.
- When the spider's feet cross a key sentence, it is highlighted and a
  short (<=9 word) summary is added to the TL;DR panel, in original article
  order.
- An optional Anthropic (Claude) integration can generate the short
  per-sentence summaries and a 3-line "Write TL;DR with Claude" digest. Without
  an API key, the extension still works fully offline using local
  rule-based summarization.
- Click the toolbar icon again (or press **Close** in the panel) to
  completely remove the spider and restore the page.

## Project file structure

```
tldr-crawler/
  manifest.json       Manifest V3 definition (permissions, icons, background, options)
  background.js       Service worker: toggles the crawler, proxies all Anthropic API calls
  content.js           The crawler itself: article detection, sentence scoring,
                       spider physics/rendering, highlighting, word glitches,
                       the TL;DR panel UI, and full cleanup/shutdown logic
  options.html         Settings page markup
  options.js           Reads/writes the Anthropic API key + model to chrome.storage.local
  icons/16.png         Toolbar/menu icon
  icons/48.png         Extension management icon
  icons/128.png        Chrome Web Store / install icon
  tools/make_icons.py  One-time local dev script that generated the icons above
                       (stdlib-only PNG writer; not used by the extension at runtime)
  README.md            This file
```

## Installing in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `tldr-crawler` folder.
5. Pin "TL;DR Crawler" to the toolbar (puzzle-piece icon -> pin).

## Configuring the Anthropic API (optional)

The extension works completely offline without this step, using local
fallback summaries. To enable AI-generated summaries:

1. Right-click the TL;DR Crawler toolbar icon and choose **Options**, or
   open it from `chrome://extensions` -> TL;DR Crawler -> **Details** ->
   **Extension options**.
2. Paste your Anthropic API key (starts with `sk-ant-...`).
3. Optionally set a specific model name (defaults to a current small/fast
   Claude model if left blank).
4. Click **Save**.

The key is stored only in `chrome.storage.local` on your machine and is
only ever read by the background service worker when it makes a request
directly to `https://api.anthropic.com/v1/messages`. It is never embedded
in source code, never logged to the console, and never sent to any other
destination.

## Using the crawler

1. Open any normal article/blog/news page.
2. Click the TL;DR Crawler toolbar icon. A small blue spider appears and
   starts following your mouse.
3. Move your cursor over the body text (including scrolling the page) to
   let the spider walk across it. As it crosses key sentences, they get a
   soft yellow highlight and a short summary appears in the panel,
   top-right.
4. Occasionally a word the spider steps on will get a small visual
   "glitch" effect (monospace, outline, highlight, slight rotation, extra
   letter spacing, blur, or uppercase) - purely cosmetic and fully
   reversible.
5. Use the panel buttons:
   - **Copy TL;DR** - copies the discovered summaries (in article order)
     to your clipboard as plain text.
   - **Restart** - clears all discovered highlights/glitches/summaries and
     starts crawling again, without reloading the page.
   - **Write TL;DR with Claude** (only shown if an API key is configured) -
     sends everything discovered so far to Claude and asks for an exact
     3-line neutral summary, shown under the list.
   - **Close** (or the `x`) - fully shuts the crawler down.
6. The panel header can be dragged anywhere on screen.

### Restart vs. Close

- **Restart**: undoes all highlights and word glitches, clears the summary
  list and progress bar, and lets the spider begin discovering sentences
  again immediately - no page reload needed.
- **Close** / clicking the toolbar icon a second time: performs a complete
  shutdown - removes the canvas, the panel, all highlights, all glitch
  effects, the injected stylesheet, the `MutationObserver`, every event
  listener and timer the extension added, and resets the extension's
  internal state - restoring the page as closely as possible to how it
  looked before the crawler started. Normal scrolling, clicks, links,
  forms, text selection, and keyboard input are never affected while the
  crawler is active.

## Troubleshooting

- **Nothing happens when I click the icon.** The extension cannot run on
  Chrome internal pages (`chrome://...`), the Chrome Web Store, or other
  pages where script injection is blocked by the browser. Try it on a
  normal `https://` article page.
- **No highlights appear.** Move your mouse directly over paragraph text
  in the main article body; the spider only discovers sentences in the
  page's detected main content area (not navigation/header/footer/ads).
  Very short pages may not have 5 "key" sentences to find.
- **"AI unavailable" appears.** The Anthropic request failed (no/invalid
  API key, network issue, rate limit, or an unexpected response). The
  crawler keeps working normally with local fallback summaries regardless.
- **Double spiders / nothing toggles off.** This shouldn't happen - a
  single global flag guards against duplicate instances, and the same
  toolbar click that starts the crawler is what shuts it down. If a page
  behaves oddly, click the icon to close, then reopen the page.
- **Dynamic / infinite-scroll pages.** New content is picked up
  automatically (via a debounced `MutationObserver`, ~1s after changes
  settle) and merged into the key-sentence pool without reprocessing
  unchanged content.

## Privacy & security

- By default, TL;DR Crawler runs **entirely locally** - no network
  requests are made, and no page content ever leaves your browser.
- Article text is sent to Anthropic's API **only if you have configured an
  API key** and **only** the sentences the spider has already discovered
  (or, for per-sentence summaries, the batch of newly discovered key
  sentences) are sent - never your full browsing history, never unrelated
  page content.
- All requests to Anthropic originate from the extension's background
  service worker, not from the webpage context, and the API key is never
  exposed to the pages you visit or printed to the console.
- Webpage text sent to Claude is always explicitly framed in the prompt as
  untrusted data to summarize, with an explicit instruction that any
  embedded text that looks like instructions must be ignored - this is a
  defense-in-depth measure against prompt-injection content hidden in
  webpages.

## Uninstalling

1. Open `chrome://extensions`.
2. Find "TL;DR Crawler".
3. Click **Remove**, then confirm.

This also deletes the locally stored API key (`chrome.storage.local` data
is removed when an extension is uninstalled).
