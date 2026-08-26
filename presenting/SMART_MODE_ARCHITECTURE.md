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

Smart slides have no constrained schema to map to real pptx shapes — an
LLM can emit arbitrary Tailwind/Chart.js markup, so (for now) every Smart
slide exports as **one full-bleed raster picture**, same tier as
"unsupported content" in the TemplateV2 native-export path.

**File:** `src/presenting/services/smart-slide-render.ts` — wraps the slide
HTML in the same Tailwind/Chart.js CDN scaffold the frontend uses, loads it
in the vendored Chromium via `puppeteer-core` (not the vendored runtime's
own `html-to-image` task type — that only accepts a *complete* HTML
document and doesn't give a hook to wait for CDN scripts + a Chart.js paint
tick), screenshots it, and hands that PNG to `pptx-from-json` as a
`picture` shape.

This reuses infrastructure built the same session for TemplateV2's own
native export path — worth understanding since "generating these slides"
really means the whole pipeline end to end:

### The native (non-raster) TemplateV2 export path

**Files:** `dom-slide-renderer.ts`, `dom-layout-resolver.ts`,
`slide-to-pptx-shapes.ts`, `native-pptx-export.ts`.

A TemplateV2 slide's `ui` tree gets rendered as *real* HTML/CSS (flexbox for
`flex`, CSS grid for `grid`, real font properties for `text`) instead of
approximating the layout in JS. That HTML is loaded in the vendored
Chromium via `puppeteer-core`, and every marked leaf element's
`getBoundingClientRect()` is read back — so text wrap points, flex/grid
positions etc. come from a *real* layout engine, not a JS heuristic. Those
exact positions become `pptx-from-json` shapes (`textbox`/`picture`/
`autoshape`), producing genuinely editable text in the exported `.pptx`.

Native shape support is intentionally narrow in v1: `text`, `text-list`,
`image`, and *unrotated, unstroked, axis-aligned-rectangle* `vector`
elements (characterized via forced-pydantic-error probing against the
frozen `convert-darwin-arm64` binary — `autoshape` only supports
`shape_type`/`position`/`fill.color`, no stroke, no corner radius, no
rotation). Anything else on a slide (charts, tables, non-rect/stroked/
rotated vectors, filled containers, svg, infographic, an unresolvable image
source) makes that *whole slide* fall back to the pre-existing raster
`json-to-image` path — never a partial/broken native render.

Two real, non-obvious bugs found and fixed while building this (both via
directly testing the frozen `pptx-from-json` binary, not by reading docs —
there are none):

1. **Position offset keys are `left`/`top`, not `x`/`y`.** The first
   attempt used `{x, y, width, height}` (matching how `position`/`size` are
   split everywhere else in this codebase) and every shape silently landed
   at `(0,0)` — unrecognized fields are dropped, not rejected, so this
   produced no error at all. Caught by testing a deliberately non-zero
   position and reading the real output back with `python-pptx`.
2. **Two concurrent Chromium instances hang.** Running this session's own
   `puppeteer-core`-driven Chromium for DOM readback *while also* calling
   the vendored runtime's raster fallback (which spawns its *own* separate
   Chromium via `runExportTask`) deadlocks. Fixed by splitting into two
   passes — resolve every slide's native geometry first with one shared
   browser, close it, *then* render whatever fell back to raster.

All slides (native shapes + raster-fallback pictures + Smart-mode raster
pictures) are assembled into **one single `pptx-from-json` call** — the
whole deck is one real python-pptx-built file, not a mix of a hand-rolled
OOXML writer and something else. The old hand-rolled ZIP writer
(`assemble-pptx.ts`) is still in the tree as an unused fallback reference —
nothing calls it anymore.

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

- **Smart export is always raster.** No native (editable-text) export path
  for arbitrary Smart HTML — would need per-element semantic tagging
  (which DOM nodes are text vs. decoration vs. chart) that the current
  generation/edit prompts don't produce.
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
