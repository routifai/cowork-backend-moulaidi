# Smart Generation — Architecture

How Hypatia's "Smart Generation" mode actually works: the LLM writes real
HTML/Tailwind/Chart.js per slide directly, instead of the JSON element tree
Preset/Imported Templates use. This is a deliberate architectural fork, not
an extension of the TemplateV2 system — the two share almost no code path
after the initial `template` dispatch.

## Why two systems exist

Preset/Imported Templates store each slide as a `ui` JSON tree
(`{components: [{position, elements: [...]}]}`) rendered by a Konva canvas
(`TemplateV2KonvaSlide`). That's great for structural editing (drag, resize,
per-element tool calls) but every visual capability has to be modeled as a
JSON schema field first — there's no way to say "put a Chart.js chart here"
without teaching the whole rendering/export pipeline what a chart element
is.

Smart mode inverts this: the LLM writes the actual `<section>` HTML
directly — real Tailwind classes, a real `<canvas>` + Chart.js init script.
Nothing has to be modeled in a schema first. This mirrors Presenton's own
Smart mode almost exactly (confirmed by reading their actual source,
`servers/fastapi/utils/llm_calls/generate_smart_presentation.py` — not
inferred), because that's genuinely why Presenton's Smart output looks
pixel-perfect: there's no JSON translation layer to lose fidelity through.

## 1. Generation

**File:** `src/presenting/services/smart-generation.ts`

One blocking model call (`deps.modelRuntime.completeSimple`, same idiom as
every other generation service in this codebase) returns the *entire deck*
as one delimited text blob:

```
<!-- PRESENTATION_TITLE: concise deck title -->
<!-- SLIDE_START -->
<section data-slide-type="title" data-slide-title="..."
  class="relative h-[720px] w-[1280px] overflow-hidden ...">
  ...real HTML...
</section>
<!-- SLIDE_END -->
<!-- SLIDE_START -->
...
<!-- SLIDE_END -->
```

The system/user prompts (`SMART_DECK_SYSTEM_PROMPT`,
`SMART_DIRECT_HTML_PROMPT`, `SMART_OVERFLOW_PREVENTION_PROMPT`,
`SMART_VISUAL_EVIDENCE_PROMPT`, `CHART_JS_INSTRUCTIONS`) are a near-verbatim
port of Presenton's own prompt strings — same overflow rules (48-64px safe
area, font-size step-down ladder, no `overflow-hidden` on text), same
Chart.js contract (one `<canvas id="chart-xxxxxx">` + one inline IIFE
calling `new Chart(...)` per chart, `responsive: false`, `animation: false`,
`Chart`/`ChartDataLabels` assumed globally available).

**Parsing** (`parseSmartPresentationHtml`) extracts the title marker and
every `SLIDE_START`/`SLIDE_END` block via regex, then **validates each
slide** before accepting the deck at all:

- `normalizeSmartSlideHtml` — strips markdown fences, disallowed document
  tags (`html`/`head`/`body`/`iframe`/`form`/...), event-handler attributes,
  `javascript:` URLs; sanitizes `<script>` blocks (keeps only inline
  `new Chart(...)` initializers with no `fetch`/`eval`/`document.cookie`/etc,
  drops anything else); requires the root `<section>` to carry
  `relative h-[720px] w-[1280px] overflow-hidden`.
- `validateChartInitializers` — every `<canvas id="chart-...">` must have a
  matching inline script that actually references that id, or the slide is
  rejected outright (a chart canvas with no initializer renders as a blank
  box).
- `validateSmartSlideLayoutSafety` — rejects scrollbars/`line-clamp`/
  `truncate`, checks word/character counts against per-slide-type budgets
  (title/TOC/visual/text-led each have their own limit), and runs
  `inspectSmartSlideLayout`.

**`src/presenting/services/smart-slide-layout.ts`** is a full port of
Presenton's `smart_slide_layout.py` — a hand-rolled HTML tag-tree parser
(not a new dependency; matches this repo's existing preference for
hand-rolling small parsers) that walks the generated markup looking for:
absolutely-positioned meaningful content with incomplete/negative/
off-canvas geometry, `overflow-hidden` wrapping visible text, and sibling
elements that overlap. Any hit fails validation.

On any validation failure, `generateSmartPresentation` retries the whole
deck (up to 5 attempts) with the failure message appended to the prompt as
feedback. This is a **simplification** of Presenton's own retry loop:
Presenton streams the response and accepts/retries per-slide incrementally;
Hypatia's existing generation commands are all blocking request/response
(no per-turn streaming plumbing yet), so this retries the whole deck instead
of just the failing slide.

## 2. Storage

```sql
-- presentations table
generation_mode TEXT NOT NULL DEFAULT 'standard'   -- 'standard' | 'smart'

-- slides table
html_content TEXT   -- populated for Smart slides, NULL for TemplateV2 slides
ui           TEXT   -- populated for TemplateV2 slides, NULL for Smart slides
```

`saveGeneratedSmartPresentation` (`db/presentation-store.ts`) writes
`generation_mode='smart'` and one row per slide with `html_content` set,
`content`/`ui` left empty. **Both columns already existed in the schema
before this work** — `generation_mode` and `html_content` were provisioned
but nothing ever wrote a non-`'standard'` row.

## 3. Dispatch

`commands/start-generation.ts` treats `template === "smart"` as a reserved
sentinel (never a real Preset/Imported Template id — those are bare names
or `imported:<uuid>`) and routes straight to `generateSmartPresentation`
instead of the TemplateV2 `generatePresentation` pipeline. Everything else
(document-upload → `content` string, memory-layer context storage) is
shared with the standard path since it all happens before this branch.

## 4. Chat editing

The three chat tools Smart mode needs — `getSmartPresentationContext`,
`getSlideAtIndex`, `saveSlide` — already existed in `chat/tools.ts` and
`chat/prompts.ts` (a whole `SMART_CHAT_AI_ASSISTANT_SYSTEM_PROMPT` was
already written) **before this session**, but the underlying
`PresentationContextStore` methods (`db/presentation-context.ts`) were
never actually implemented for Smart mode:

- `getSmartPresentationContext` was a literal stub:
  `{message: "Smart presentation mode not fully implemented.", slides: []}`.
- `getSlideAtIndex` only ever read `content`/`ui` (always empty for Smart
  slides) — the model had no way to see a slide's actual HTML.
- `saveSlide` required a real template `layoutId`; the Smart branch in
  `tools.ts` passed a sentinel `"__smart_slide__"` that could never resolve
  to a real layout, so every Smart edit failed with "Layout
  '__smart_slide__' not found."

All three are now real: `getSlideAtIndex`/`getSmartPresentationContext`
read `html_content` directly; `saveSlide` branches on
`this.presentationType === "smart"` into `saveSmartSlideHtml`, which
validates the replacement HTML with the *same* `normalizeSmartSlideHtml`
used at generation time (so a bad chat-edit gets rejected with a real error
instead of corrupting the slide) and writes it straight to `html_content`.

`PresentationChatService` (`chat/service.ts`) gates on this: it reads the
presentation's stored `generation_mode` and throws if the caller's
`presentationType` doesn't match, so the frontend must pass
`presentation_type: deck.generation_mode` on every `chatEdit` call.

## 5. Rendering

**File:** `hypatia-frontend/src/presenting/components/SmartSlideRenderer.tsx`

A sandboxed `<iframe sandbox="allow-scripts" srcDoc={...}>` wraps the raw
`<section>` in a scaffold that loads Tailwind and Chart.js from CDN
(`cdn.tailwindcss.com`, `cdn.jsdelivr.net`) — **this requires internet
access**, same as Presenton's own Smart mode; there is no offline-bundled
Tailwind/Chart.js build vendored. Always renders at the native 1280×720 and
lets `<ScaledSlideStage>`'s CSS transform scale it down for thumbnails.

**Click-to-select:** Smart slides have no drag/resize editing — there's no
structural element tree to move, `saveSlide` only ever replaces the whole
slide's HTML. But selecting an element to scope the next chat message to
("edit *this*") is still useful, so the interactive instance (main editor
view only, never sidebar thumbnails) gets an injected click handler that
walks up from the click target to the nearest "meaningful" element (has
visible text, or is `canvas`/`img`/`svg`/`video`), highlights it, and
`postMessage`s a short description back to the host page (the iframe's
`srcDoc` gives it an opaque origin, so this can't reach across the DOM
directly). The host translates that into the same
`{slideIndex, label}` selection state the TemplateV2 canvas's own
click-to-select already populates, so the existing "user selected X"
context-injection in `sendChat()` just works unmodified.

## 6. Export

Smart slides have no constrained schema to map to real pptx shapes — an LLM
emits arbitrary Tailwind/Chart.js markup, not a known JSON tree. Export
does **not** reimplement a DOM→shapes conversion on our side — it wraps the
whole deck in Presenton's own real export-page DOM structure and hands it
to their own `@presenton/export-core` package's `html-to-any` task, which
runs their actual production conversion pipeline (the same one their app
uses) and returns a real `.pptx`. Two earlier versions of this file existed
this session and were both replaced:

1. A raster-only version (one full-bleed screenshot per slide, no editable
   text at all).
2. A custom DOM-extraction version (`smart-dom-extractor.ts` +
   `smart-shape-mapper.ts`, both deleted) that walked the rendered DOM
   itself and mapped leaves to `pptx-from-json` shapes directly — real
   editable text, but far more conservative than Presenton's own pipeline:
   any gradient background or chart sent the *whole slide* to raster (later
   improved to per-element raster, still worse than just using their real
   pipeline). Verified head-to-head against the same gradient-heavy sample
   deck: the custom extractor exported 0 fully-native slides where
   Presenton's real pipeline exported editable text on every slide, with
   only 2-3 small rasterized decorative elements per slide (see below).

**Files:**
- `smart-slide-render.ts` — `wrapSmartDeckHtml(sections: string[])`. Ports
  Presenton's real `servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx`
  (genuinely open source, not obfuscated — unlike export-core itself) DOM
  structure field-for-field: an `#presentation-slides-wrapper` containing
  one `.main-slide` per slide, each holding `.slide-export-inner` >
  `smart-slide-export-root` > `smart-slide-export-content` > the raw
  `<section>` HTML, plus their exact `PDF_PRINT_STYLE` sizing rules
  (`1280x720` fixed `.main-slide`, flex-column stacking, no gaps/margins).
  This isn't cosmetic — `html-to-any`'s handler specifically looks for
  `#presentation-slides-wrapper` and throws `"Presentation slides wrapper
  not found"` (HTTP 400) without it. Confirmed by testing a bare single
  `<section>` first (fails with that exact error) before finding and
  porting the real wrapper.
- `export-runtime.ts` — `runHtmlToAnyPptxTask(html, title, runtime,
  tempDir)` calls `{type: "html-to-any", html, format: "pptx", title}`
  against the vendored package.
- `native-pptx-export.ts` — `exportPresentationNatively()`, now just: wrap
  every slide's HTML, call `runHtmlToAnyPptxTask()` once for the whole
  deck, copy the result to the output path. No browser management, no
  per-slide loop, no leaf classification on our side at all.

**Vendored runtime.** `export-runtime.ts` dynamically `import()`s
`@presenton/export-core`
(`presenting/engine/vendor/presentation-export/node_modules/`) and calls
its typed `runTask()` in-process — no subprocess, no task-file/response-file
protocol. This replaced an earlier vendored runtime (Presenton's old
Electron-era export pipeline, pinned at `v0.4.8`) that shelled out to a
frozen Python binary (PyInstaller) via exactly that subprocess protocol.
Confirmed `v0.4.8` was the last release in that lineage — no newer
platform build exists — and that Presenton's real current pipeline is this
package: a full rewrite, pure TypeScript, "Python is not required" per its
own README. It's fetched from `https://github.com/presenton/presenton-export`
release tarballs (see `sync-presentation-export.mjs`) rather than the npm
registry — publicly downloadable, but still run through
`javascript-obfuscator` (a real devDependency of the package). Reading its
actual DOM→shapes conversion logic (to find the real `PptxAutoShapeBoxModel`/
`PptxTextBoxModel`/`PptxFontModel` schema, and to root-cause the
`html-to-any` wrapper requirement) meant downloading the release tarball
and beautifying the obfuscated bundle by hand, not `npm view`-ing readable
source.

**Two real quirks found and fixed along the way** (both from directly
testing the vendored binary, not from assumption):

1. **`page.evaluate(fn)` breaks under this repo's esbuild build** — hit
   during the now-deleted custom-extractor version, but worth keeping as a
   documented gotcha since it'll resurface for any future `page.evaluate`
   use in this codebase. Passing a live function reference (rather than a
   string) throws `ReferenceError: __name is not defined` — both `tsx`
   (dev) and `pnpm run bundle` (prod) inject esbuild's name-preservation
   helper (`__name(fn, "fn")`) into transpiled functions, and that helper
   only exists in the calling module's scope, not in the re-evaluated
   string Puppeteer serializes via `Function.prototype.toString()`. Fix:
   stringify the function and wrap it with a local
   `function __name(fn){return fn}` shim before `page.evaluate()`.
2. **`autoshape.border_radius` is a real, typed schema field that doesn't
   render** — found while the custom extractor was still in use: their own
   code emits it, but the resulting shape's `<a:prstGeom>` stayed `"rect"`,
   never `"roundRect"`, no error either way. Moot now that export goes
   through their real `html-to-any` pipeline instead of us hand-building
   `pptx-from-json` shapes ourselves — whatever their pipeline does with
   rounded corners internally (screenshot the element, approximate it,
   accept the gap) is now exactly what ships, not a second-guessed
   reimplementation of it.

Verified end-to-end against the real bundled sample deck that originally
exposed the custom extractor's weakness
(`presenting/smart-examples/arcade-sys-a-history-of-the-coin-op-era.json`,
a CRT/gradient-heavy visual style — every slide has a gradient background):
every slide now exports 7-8 real `AUTO_SHAPE`/text shapes plus only 2-3
`PICTURE` shapes for genuinely irreducible decorative elements (the
gradient background, a CRT bezel graphic) — not one full-slide raster
picture. Confirmed with `python-pptx` against the real output file, not
assumed from the task response alone.

## 7. Edit compare/keep ("Select edits")

After a chat-edit turn, `PresentingPanel.tsx` snapshots every slide before
calling `chatEdit`, diffs the refreshed deck afterward
(`diffSlideIndices` — string-fingerprints `html_content`/`content`/`ui` per
index), and — if anything actually changed — shows an Original/Modified
comparison with real mini-renders (reusing `SmartSlideRenderer`/
`TemplateV2KonvaSlide`, whichever the slide is). Clicking "Original" calls
the new `presenting_restore_slide` command (a direct DB write, no LLM) for
each changed index; "Modified" just confirms the already-applied edit.

This is a **simplified equivalent** of Presenton's own version, not a
literal port: Presenton streams per-tool-call traces live and snapshots a
slide the instant a mutating tool call *starts* (their `Chat.tsx`,
`onTrace` callback + `MUTATING_TOOLS` set). Hypatia's `chatEdit` is one
blocking call with no intermediate tool-call visibility surfaced to the
frontend, so this reconstructs the same before/after picture from a single
whole-deck diff computed after the turn finishes, rather than progressively
during it. Known gap: it only diffs when slide *count* is unchanged — an
edit that inserts or deletes a slide shifts indices and the diff won't line
up (not silently wrong in a dangerous way, just skipped: no comparison
shown).

## Known limitations (honest, not yet fixed)

- **Native-export fidelity is now entirely Presenton's own, not ours to
  tune.** Since §6's rewrite, export goes through their real `html-to-any`
  pipeline rather than a custom DOM-extraction/shape-mapping layer — so
  whatever their pipeline does or doesn't natively represent (rounded
  corners, gradients, per-run bold/italic mixing) is exactly what ships.
  We no longer control or can easily improve that fidelity on our side; the
  only lever left is the DOM/HTML we hand them (`wrapSmartDeckHtml()`), not
  a shape-mapping layer to extend.
- **Requires internet.** Tailwind + Chart.js load from CDN for both the
  live iframe preview and the export screenshot. No offline bundle.
- **No design-reference input.** Presenton's own Smart mode can anchor
  style on a hosted "community" gallery (raw HTML slides from *other*
  generated decks, pasted into the prompt as style-only few-shot context —
  confirmed by reading `community_presentations.py`, not assumed). Hypatia
  has no equivalent yet; the prompt has no slot for it.
- **A live bug under investigation as of this writing:** a user-reported
  case where the main editor view (and the "Modified" comparison thumbnail)
  rendered a slide blank after a chat edit added a second chart, despite
  the model's own reply and the sidebar thumbnail showing the title text
  existed. Not yet root-caused — needs either a browser console error or
  the raw post-edit HTML to diagnose, since the in-memory SQLite DB isn't
  inspectable from outside the running app process.
