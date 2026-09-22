# Can the AI look things up on the web? (state of play + how to finish it)

Asked 2026-09-22: *"does the pi bridge currently have a web browser that helps look for
things that the AI does not yet know of?"*

Short answer: **partly - there is a text-only web reader, not a browser, and the chat
window on a device cannot use it at all.**

---

## 1. What exists today

`src/tools.js` → `webTools()` (defined at the "Web research" section) gives two tools:

| Tool | What it does | How |
|---|---|---|
| `web_search` | top ~6 results: title, URL, snippet | scrapes `https://html.duckduckgo.com/html/?q=...` with a fake User-Agent and two regexes |
| `web_fetch` | one page as readable text | `fetch(url)`, strips `<script>/<style>/<tags>`, returns the first **9,000 characters** |

Verified working from the bridge host on 2026-09-22 (DuckDuckGo HTML endpoint answered
200 with 10 results in ~0.6 s). No API key, no account, no cost.

### Which surfaces actually have them

| Surface | Code | Web tools? |
|---|---|---|
| Ticket triage (autowork) | `buildTicketTriageTools()` | **yes** |
| Helpdesk / decision chat ("Johnny 5 Need Input!"), sales & discovery chats | `buildDecisionTools()` → `baseTools` | **yes** |
| **Device chat (the Pi Chat window on a machine / multi-machine)** | `buildTools()` | **no** |
| Report finalizer | `buildReportTools()` | no (by design - no external access needed) |
| Procedure mining | `buildProcedureMiningTools()` | no |
| **Task-prompt assistant** (`runAssist`, "help me write this prompt") | `createAgentSession({ noTools: "builtin", customTools: [] })` | **no - but its prompt promises them** |

Two defects fall straight out of that table:

1. **The device chat cannot research anything.** It is the window a technician sits in
   while fixing a machine - exactly where "what does error 0x800706b9 mean on Server
   2019" belongs - and the model has no way to find out. It does not even know it is
   missing: nothing in that system prompt mentions research.
2. **`taskPromptAssistSystemPrompt()` (server.js ~4456) tells the model to "RESEARCH
   unknowns itself with `web_search` / `web_fetch`"** while `runAssist()` builds the
   session with no tools at all. The model is being told it can do something it cannot,
   which is how you get an assistant that invents a citation instead of admitting it does
   not know.

### What the current reader cannot do

* **No JavaScript.** Anything rendered client-side (most vendor portals, Atlassian docs,
  Reddit, Microsoft Learn's interactive bits) comes back as navigation furniture or an
  empty shell.
* **No timeout.** `_webFetch` has no `AbortSignal`; a server that accepts the connection
  and never answers holds the turn open until the turn watchdog gives up on it.
* **No SSRF guard.** `web_fetch` will happily fetch `http://127.0.0.1:8787/pi/...`,
  `http://169.254.169.254/...` (cloud metadata), or anything on the customer LAN the
  bridge host can route to. Today the only thing standing between a hostile page ("fetch
  this URL for the full fix") and our own internals is that nobody has tried.
* **No redirect/scheme checks** (`redirect: "follow"`, any scheme `fetch` accepts).
* **9 KB per page, one page at a time, no paging** - a long KB article is truncated
  mid-sentence with no way to continue, and the model cannot tell that happened.
* **No PDFs** (a PDF returns binary noise as "text"), no images, no screenshots.
* **No authentication**, so vendor portals behind a login are out.
* **No caching and no rate limiting** - ten questions about the same error scrape
  DuckDuckGo ten times. Being blocked is a matter of when, not if, and when it happens
  the failure is a silent "(no results)".
* **No audit trail.** A prompt, a device command and a spend event are all logged; what
  the AI *read off the internet* is not. For an admin asking "why did it tell the
  customer that", the source is gone.
* **Not gated by anything.** No role permission, no Global Setting, no per-client switch.

---

## 2. How I would implement it properly

Four stages, each useful on its own. Stage 1 is an afternoon; stage 4 is only worth doing
if stages 1-3 prove insufficient.

### Stage 1 - make what we have safe, honest and available (do this first)

Nothing new to install; all in `src/tools.js` + two call sites.

1. **Extract a `web-research.js` module** out of `tools.js` (`_webSearch`, `_webFetch`,
   `webTools`). It is about 60 lines and wants its own tests, which it currently cannot
   have without importing the 2,900-line tool belt.
2. **Harden `web_fetch`** (in that order, because each one is a real failure mode):
   * `AbortSignal.timeout(Number(process.env.PI_WEB_TIMEOUT_MS || 15000))`.
   * **Scheme allowlist**: `http:`/`https:` only.
   * **SSRF block**: resolve the host with `dns.lookup(host, { all: true })` and refuse
     loopback, link-local (`169.254/16`, `fe80::/10`), private ranges
     (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`), CGNAT, `.local`, and bare
     hostnames with no dot. Re-check **after every redirect** (`redirect: "manual"`, loop
     at most 5 times) - a public URL that 302s to `127.0.0.1` is the classic bypass.
     Return a refusal the model can read: *"Refused: that URL resolves to a private
     address. Internal systems are reached with the device tools, not web_fetch."*
   * **Response cap by bytes, not characters**, streaming and stopping at ~2 MB, and
     **say so in the result** (`[truncated - 9,000 of 41,300 characters; call web_fetch
     with offset=9000 for the next part]`) with an `offset` parameter to honour it.
     A model that knows it was truncated asks for the rest; one that does not invents it.
   * **Content-type switch**: `text/html` → strip; `text/plain`/`application/json` →
     pass through; `application/pdf` → extract text (stage 2) or refuse by name; anything
     else → refuse by name rather than returning binary.
3. **Better extraction than "strip every tag"**: drop `nav/header/footer/aside/form/svg`,
   prefer `<main>`/`<article>` when present, keep link text. `@mozilla/readability` +
   `linkedom` do this well and are ~1 MB installed, no browser. Also keep the page
   `<title>` and the final URL, and **prepend both to the result** so the model quotes a
   source it can name.
4. **Give the device chat the tools**: add `...webTools()` to `buildTools()`'s list, and a
   line to the device-chat system prompt: *research with `web_search`/`web_fetch` before
   guessing at a command; name the source when you do.* Read-only sessions keep them -
   reading a vendor doc changes nothing on the machine - and they are **not** in the
   `mutating` set, so they never need an approval click.
5. **Fix `runAssist`**: either pass `customTools: webTools()` (it is a research-shaped
   job, so yes) or delete the RESEARCH paragraph from that prompt. Do not ship the
   mismatch.
6. **Log every lookup**: `log("web_search", key, query)` / `log("web_fetch", key, url)`,
   and record a history row (`queue.js` `record()`) so the admin-facing history shows
   *what the AI read* next to *who asked* - the attribution work done the same day is
   only half the picture otherwise.
7. **Cache** search results and fetched pages in `sessions/<scope>/web-cache/` keyed on a
   hash of the query/URL, 24 h TTL, ~50 MB LRU. Cheap, and it is what keeps us under
   DuckDuckGo's patience.

### Stage 2 - a search API that will not be blocked, and PDFs

* **Search**: keep the DDG scrape as a fallback, but prefer a real API when a key is
  configured - **Brave Search API** (2,000 free queries/month, no attribution strings,
  clean JSON) or **Tavily** (built for LLMs, returns extracted content with the results,
  which removes a whole round trip). Key in `/etc/pi-trmm-bridge.env`
  (`PI_WEB_SEARCH_PROVIDER`, `PI_BRAVE_KEY`, `PI_TAVILY_KEY`); provider chosen at
  `webTools()` build time, so no code path changes when a key appears.
* **PDFs**: `pdf-parse` (or `pdftotext` from poppler-utils, already common on the box) -
  vendor fixes live in PDFs more often than anyone likes.
* **A per-tenant switch**: a Global Setting (`ai_web_research_enabled`) plus an optional
  per-client override, because some customers will not accept their ticket text becoming
  a search query. Default on, documented, switchable - the same shape as Auto-approve.
  The query text is the thing to be careful with: **never send customer names, emails,
  hostnames or ticket bodies verbatim**. Strip them in `_webSearch` and say what was
  stripped.

### Stage 3 - a real (headless) browser, only where it earns its keep

Playwright + Chromium on the bridge host (~400 MB) behind the SAME two tools, used only
when the plain fetch came back with less than a paragraph of text:

* `browse_page(url)` - render, wait for network idle, return readable text + the final
  URL. Same SSRF/timeout/cap rules; **no** cookie persistence, fresh context per call.
* `browse_screenshot(url)` - a PNG for the vision models, so "what does this vendor page
  actually look like" is answerable. Reuse the existing image path
  (`attachments.js` already sends images to models that accept them).
* Run it in **one long-lived browser process with per-call contexts**, capped at 2-3
  concurrent pages, `--no-sandbox` avoided (run as the `tactical` user, not root), and a
  hard 30 s per page. A crashed browser must degrade to stage 1, not fail the turn.
* Do **not** give it the ability to log in, type into forms, or click through consent
  walls. A tool that can authenticate as us on a third-party site is a different
  security conversation, and the honest answer to a login wall is "a human must read
  this one".

### Stage 4 - our own knowledge first

The best answer to "the AI does not know this" is usually not the internet:

* Search the **global KB** and the client KB (`list_kb_articles` / `get_kb_article`,
  already in the ticket surfaces) **before** the web, and say which one the answer came
  from. The device chat does not have those either - worth the same one-line fix.
* When a web lookup solves something, offer to write it into the KB
  (`create_global_kb_article`), so the second occurrence costs nothing. The plumbing for
  that exists; only the prompt nudge is missing.

---

## 3. Order of work, with effort

| # | Change | Effort | Why it is in this position |
|---|---|---|---|
| 1 | `web-research.js` + timeout + scheme/SSRF/redirect guards + byte cap + honest truncation | ~half a day | it is a live SSRF hole and a stall risk |
| 2 | Readability extraction, title/URL in the result | ~2 h | doubles the usefulness of every fetch |
| 3 | Web tools in the **device chat** + prompt line | ~1 h | the actual ask |
| 4 | Fix `runAssist`'s false promise | ~10 min | it is lying to the model today |
| 5 | Logging + queue-history rows + cache | ~half a day | an admin has to be able to see what it read |
| 6 | Brave/Tavily behind an env key, DDG as fallback | ~half a day | removes the silent-block failure |
| 7 | PDF text | ~2 h | vendor fixes live there |
| 8 | Global Setting / per-client switch + query scrubbing | ~half a day | privacy, and someone will ask |
| 9 | Playwright `browse_page` / `browse_screenshot` | ~2 days incl. packaging | only after 1-8 prove insufficient |

Tests to write alongside (all pure, no network): URL guard table (loopback, private,
link-local, redirect-to-private, non-http scheme, no-dot host), extraction on saved HTML
fixtures, truncation/offset paging, cache hit/miss/TTL, and "search provider falls back to
DDG when no key is set".
