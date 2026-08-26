# Smart-mode PPTX export

How a Smart-generated presentation (`slide.html_content`, arbitrary
LLM-written Tailwind/Chart.js HTML — see `SMART_MODE_ARCHITECTURE.md` for
how those slides are generated) becomes a real, PowerPoint-editable
`.pptx` file.

## The short version

We don't parse or convert the DOM ourselves. We wrap the deck in the exact
DOM structure Presenton's own export page uses, and hand it to Presenton's
own real conversion pipeline (`@presenton/export-core`, vendored). Their
pipeline decides what becomes editable text/shapes vs. a rasterized
picture — the same decision their own product makes for their own users.

## Why not build our own DOM→shapes conversion

Two earlier versions of this file did exactly that, both since deleted:

1. **Raster-only.** Every slide screenshotted whole and dropped into the
   pptx as one full-bleed picture. Technically valid, zero editable text.
2. **Custom DOM extraction** (`smart-dom-extractor.ts` +
   `smart-shape-mapper.ts`). Walked the rendered DOM ourselves —
   classified text leaves, background rects, images — and mapped them
   directly to `pptx-from-json` shapes. Real editable text, but far more
   conservative than Presenton's real pipeline: a gradient background or a
   rounded-corner card (`rounded-xl`, extremely common in LLM-generated
   Tailwind) sent the whole slide to raster, because the schema field for
   corner radius doesn't actually render and gradients aren't representable
   as a solid fill. Verified head-to-head against a real gradient-heavy
   sample deck: 0 fully-native slides.

Neither was "wrong," but both were reinventing a DOM-classification
algorithm Presenton has already built, tested, and ships in production.
Switching to call their real pipeline directly, on the same deck, produced
real editable text on every slide with only 2-3 small rasterized elements
per slide (the parts genuinely irreducible: a gradient hero background, a
chart) — a categorically better result with less code.

## How it actually works

**1. Wrap the deck in Presenton's real export-page DOM structure.**

`smart-slide-render.ts` → `wrapSmartDeckHtml(sections: string[])` ports
Presenton's own `servers/nextjs/app/(export)/pdf-maker/PdfMakerPage.tsx`
(genuinely open source, not obfuscated) field-for-field:

```
#presentation-slides-wrapper
  .main-slide (one per slide, id="slide-{i}", fixed 1280×720)
    .slide-export-inner
      .smart-slide-export-root (h-[720px] w-[1280px])
        .smart-slide-export-content (h-[720px] w-[1280px])
          <div> ← the slide's raw html_content goes here
```

Plus their exact `PDF_PRINT_STYLE` CSS (fixed sizing, flex-column
stacking, no margins/gaps). This isn't cosmetic: `html-to-any`'s handler
specifically looks for `#presentation-slides-wrapper` and throws
`"Presentation slides wrapper not found"` (HTTP 400) without it — confirmed
by testing a bare `<section>` first and getting exactly that error before
finding and porting the real wrapper.

**2. Hand the whole thing to `html-to-any`.**

`export-runtime.ts` → `runHtmlToAnyPptxTask(html, title, runtime, tempDir)`
calls the vendored package's typed `runTask()` in-process:

```ts
runTask(
  { type: "html-to-any", html, format: "pptx", title },
  { outputDirectory, tempDirectory, browserLaunchOptions: { executablePath: chromiumPath, headless: true } },
)
```

One call for the *entire deck* — not one call per slide. Their pipeline
walks the page, finds each `.main-slide`, and runs their real
DOM-extraction/shape-classification logic on each one.

**3. Copy the result.**

`native-pptx-export.ts` → `exportPresentationNatively()` is now just:
build the wrapper HTML, call `runHtmlToAnyPptxTask()` once, copy the
returned file to the output path. No browser management, no per-slide
loop, no shape-mapping code on our side at all.

## The vendored runtime

`@presenton/export-core` is a real npm package, distributed as a GitHub
Release tarball (`https://github.com/presenton/presenton-export/releases`)
rather than through the npm registry. `sync-presentation-export.mjs`
installs it into `presenting/engine/vendor/presentation-export/` (a real
`npm install`, so its own dependencies — puppeteer, sharp, its own pptx
writer — come along), plus a vendored, version-pinned Chromium build
(`chromium-cache/`, reused via `browserLaunchOptions.executablePath` so
`html-to-any` doesn't download its own).

This replaced an older vendored runtime: Presenton's previous Electron-era
export pipeline (pinned at `v0.4.8`) shelled out to a frozen Python binary
(PyInstaller) via a subprocess/task-file protocol. `v0.4.8` was confirmed
to be the last release in that lineage — no newer platform build exists —
and Presenton's real current pipeline is this package: a full rewrite,
pure TypeScript, "Python is not required" per its own README. The new
integration is simpler too: an in-process `import()` and a typed function
call, no subprocess, no task-file/response-file protocol.

**One honest caveat:** the package is publicly downloadable but its
`dist/index.js` is still run through `javascript-obfuscator` (a real
`devDependency` of the package, confirmed in its own `package.json`) —
"opensource" here means "publicly distributed," not "readable source." We
vendor and call it; we don't own or control its actual DOM→shapes
conversion logic. That was true of the old Python binary too — this isn't
a new tradeoff introduced by the migration, and it's the same position
Presenton's own production app is in (it calls this exact same package).

## What this gets us, honestly

- Real, retypeable text and native shapes on the vast majority of content,
  verified against multiple real sample decks (including gradient-heavy
  and rounded-corner-heavy styles that were worst-case for the old custom
  extractor).
- A handful of `PICTURE` shapes per slide for content that genuinely can't
  be represented as pptx shapes (charts, complex decorative graphics) —
  Presenton's own pipeline decides this, not a heuristic we wrote.
- Whatever fidelity gaps exist (e.g. how gradients or rounded corners are
  handled) are now Presenton's fidelity gaps, not ours to chase — the only
  lever left on our side is the HTML we hand them
  (`wrapSmartDeckHtml`/the Smart generation prompt itself), not a
  shape-mapping layer to keep extending.

## Files

| File | Role |
|---|---|
| `src/presenting/services/smart-slide-render.ts` | `wrapSmartDeckHtml()` — the real export-page DOM wrapper. |
| `src/presenting/services/export-runtime.ts` | Vendored-package resolution + `runHtmlToAnyPptxTask()`. |
| `src/presenting/services/native-pptx-export.ts` | `exportPresentationNatively()` — the orchestrator. |
| `src/presenting/services/export.ts` | Loads a presentation from the DB, hands slides to the above. |
| `presenting/engine/vendor/sync-presentation-export.mjs` | Installs `@presenton/export-core` + vendored Chromium. |
