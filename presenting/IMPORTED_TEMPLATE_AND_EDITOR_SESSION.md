# Imported Template pipeline, export fix, and editor UI — what was built and why

Date: 2026-08-22–23. Spans both `hypatia-backend` and `hypatia-frontend`. Written after the fact to record exactly what changed, with the actual code, so this doesn't need to be reverse-engineered from commit history later.

## 1. Imported Template pipeline (backend)

**Problem**: hypatia had 8 bundled "Preset Templates" but no way for a user to bring their own `.pptx` design. Presenton (the upstream project) has this — presenton calls it "custom template," hypatia calls it **Imported Template** (see `presenting/CONTEXT.md` for the full glossary — Preset Template vs Uploaded Template vs Imported Template are three distinct concepts, don't conflate them).

**Pipeline** (`hypatia-backend/src/presenting/services/`):

1. **`pptx-extraction.ts`** — deterministic extraction, no model call. Calls the *already-vendored* `presentation-export` runtime's `pptx-to-json` task (raw per-slide element tree) and `pptx-to-html` + `html-to-images` tasks (rendered slide PNGs). This runtime ships with hypatia already (used for `json-to-image` export, see §2) but nobody had used these other task types before — confirmed they exist by grepping the vendored `index.js` for the task-type strings, then validated end-to-end against a real `.pptx`.

2. **`template-vision-generation.ts`** — one vision/LLM call per slide (bounded concurrency, `utils/concurrency.ts`). Sends the rendered slide PNG + raw element JSON, asks the model to group elements into named `Component`s and classify each element `decorative: boolean` (fixed scaffolding vs. content slot to regenerate). This is the first place in the codebase that constructs an `ImageContent` block (`{ type: "image", data, mimeType }`) — the type existed in `pi-ai`'s `UserMessage.content` but nothing had used it.

3. **`merged-components.ts`** — pure code, no model call. Originally planned as an LLM clustering pass (matching presenton's `merge_similar_components`), but direct inspection of `template-binding.ts`/`template-schema.ts` showed the renderer only reads `layouts[]`, not `merged_components[]` — that field is dead data in this codebase (see `presenting/docs/adr/0001-imported-template-full-schema-parity.md` for the full story). So it's now a mechanical derivation from `layouts[]`, no model call, kept only for structural parity with Preset Templates in case something starts consuming it later.

4. **`import-template-orchestrator.ts`** — ties it together: extraction → vision → merged-components → asset resolution → `imported-template-store.ts`.

**Storage** (`imported-template-store.ts`): workspace-scoped, under `<hypatiaAgentDir>/presenting-imported-templates/<encoded-cwd>/<templateId>/`, separate from the read-only shipped `presenting/engine/templates/`. `template-resolver.ts` dispatches a template id to either store based on an `imported:` prefix — every call site that used to call `getTemplate()` directly (`generation.ts`, `presentation-context.ts`, `chat/service.ts`, etc.) now goes through `resolveTemplateData()` instead.

**Commands**: `presenting_import_template`, `presenting_list_imported_templates`, `presenting_delete_imported_template` (`src/commands/types.ts`, wired in `handler-registry.ts`, handlers in `src/presenting/commands/`).

**Frontend**: `ImportedTemplates.tsx` component (upload button + "My templates" grid), wired into `PresentingPanel.tsx` above the preset grid; `presentingApi.ts` wrappers; 3 new Rust `#[tauri::command]`s in `lib.rs`.

## 2. Two bugs found and fixed while building the above

These are in the **pre-existing** export code, not new — found while validating the vendored runtime for the Imported Template extraction work.

- **`export-runtime.ts`'s response check was always false.** The runtime's real success payload never sets an `ok` field at all (confirmed by actually running `json-to-image` against a real PNG and inspecting the raw response file: `{"file_path": "..."}`, no `ok` key). The old code did `if (!response.ok) throw ...` — so every real export threw "Export runtime returned ok=false" before ever reading the image path. Fixed: only treat an explicit `response.error` as failure now (failures never reach that point anyway — a non-zero process exit writes no response file at all, already caught separately).
- **`discoverChromiumPath` accepted a false match.** On case-insensitive filesystems (macOS/Windows default), `chromium-cache/Chromium` case-folds onto the shipped `chromium-cache/chromium/` directory — the function accepted this as if it were the executable (no `isFile()` check), handing Puppeteer a directory path. Separately, the real binary is 7 directory levels deep and the recursion limit was 5 — the case-fold bug had been silently masking this deeper bug the whole time (it "succeeded" via the false match before recursion ever got far enough to hit the depth limit). Both fixed.

## 3. How the Export button actually works, end to end

This was the second bug hunt — export appeared to work (no error) but the produced `.pptx` file was rejected by real Keynote with "The file format is invalid," while passing `unzip -t`, `file`/libmagic, and python-pptx's parser. Traced with a real, reproducible harness (AppleScript driving actual Keynote, reading its error dialog via System Events) rather than guessing.

### The full call chain

**1. Frontend button** — `hypatia-frontend/src/presenting/PresentingPanel.tsx`:

```ts
const exportDeck = async () => {
	if (!deck) return;
	const path = await save({
		defaultPath: `${deck.title || "presentation"}.pptx`,
		filters: [{ name: "PowerPoint", extensions: ["pptx"] }],
	});
	if (!path) return;
	setStage("exporting");
	try {
		await exportPresentation({ presentation_id: deck.presentation_id, output_path: path });
		setExportPath(path);
		setStage("editor");
	} catch (cause) {
		setError(`Export failed: ${errorMessage(cause)}`);
		setStage("error");
	}
};
```

`save()` is Tauri's native save dialog (`@tauri-apps/plugin-dialog`) — the user picks where the file goes. `exportPresentation()` (`presentingApi.ts`) is a thin `invoke("presenting_export_presentation", {...})` wrapper.

**2. Rust relay** — `hypatia-frontend/src-tauri/src/lib.rs`:

```rust
async fn presenting_export_presentation(
    presentation_id: String,
    output_path: String,
    s: State<'_, AppState>,
) -> Result<Value, String> {
    let id = format!("pep-{}", next_request_id());
    write_line_request(
        &s.sidecar.stdin,
        &s.pending_requests,
        &serde_json::json!({
            "type":"presenting_export_presentation",
            "id":id,
            "presentationId":presentation_id,
            "outputPath":output_path,
        }),
        std::time::Duration::from_secs(180),
    )
    .await
}
```

Pure relay — writes a JSON line to the Node sidecar's stdin, awaits the correlated response by `id`. No business logic here.

**3. Backend command handler** — `hypatia-backend/src/presenting/commands/export-presentation.ts`:

```ts
export async function handlePresentingExportPresentation(cmd: Record<string, unknown>): Promise<void> {
  const presentationId = String(cmd.presentationId ?? cmd.presentation_id ?? "");
  const outputPath = String(cmd.outputPath ?? cmd.output_path ?? "");
  try {
    initDb();
    const resultPath = await exportPresentationToPptx({ presentationId, outputPath });
    send({ type: "result", id: cmdId, data: { path: resultPath } });
  } catch (exc) { /* ... */ }
}
```

**4. Actual export logic** — `hypatia-backend/src/presenting/services/export.ts`:

```ts
export async function exportPresentationToPptx(opts: { presentationId: string; outputPath: string }): Promise<string> {
  const presentation = /* load from SQLite */;
  const slides = /* load slides, ordered */;
  const runtime = resolveExportRuntime();          // finds the vendored runtime + Chromium (§2 fix)
  const tempDir = mkdtempSync(...);
  const imagePaths: string[] = [];
  for (const slide of slides) {
    const ui = JSON.parse(slide.ui);
    const imagePath = await renderSlideToImage(ui, runtime, tempDir);   // one PNG per slide
    imagePaths.push(imagePath);
  }
  assemblePptx(imagePaths, opts.outputPath, String(presentation.title ?? ""));
  return opts.outputPath;
}
```

`renderSlideToImage` calls the vendored Chromium/Puppeteer runtime's `json-to-image` task (the same runtime used for Imported Template extraction, §1) — renders each slide's UI JSON to a 1280×720 PNG. **This is a raster export**: every slide becomes one full-bleed picture. Text is not natively selectable in the output `.pptx` — editing happens in Hypatia before export, not in PowerPoint/Keynote after. This tradeoff was flagged and deliberately left as-is (see `presenting/TEMPLATE_GAP_ANALYSIS.md` §3) — fixing *that* would mean reconstructing native shapes, a materially bigger task than what was done here.

**5. The actual `.pptx` writer** — `hypatia-backend/src/presenting/services/assemble-pptx.ts`, `assemblePptxFromImages(imagePaths, outputPath, title)`. A `.pptx` is a ZIP of OOXML XML files; this hand-writes that ZIP with Node's `zlib` only (no `pptxgenjs`, no python-pptx) — `buildZip()` implements the raw ZIP local-header / central-directory / end-of-central-directory format directly (PKWARE APPNOTE field-by-field).

### What was actually broken, and how it was found

Every structural validator available (`unzip -t`, python's `zipfile.testzip()`, `file`/libmagic, python-pptx's own parser) accepted the exported file as valid. Only Keynote rejected it. Rather than guess further, built a reproducible test harness — AppleScript driving real Keynote, reading its error dialog text via macOS's Accessibility API (System Events):

```bash
osascript -e "tell application \"Keynote\" to open POSIX file \"$FILE\"" &
sleep 4
osascript -e 'tell application "System Events" to tell process "Keynote" to value of static text 2 of window 1'
# -> "The file format is invalid."
```

This let real-Keynote-acceptance become a fast, scriptable check instead of a round-trip through the user. Confirmed the harness itself was valid by first testing a real python-pptx-generated file (opened fine), then bisecting by diffing the hand-rolled writer's ZIP contents against that known-good file's contents, part by part.

Three real gaps found this way, most severe first:

1. **The actual bug**: every real slide's `_rels` file declares which `slideLayout` it's based on. The hand-rolled writer's `slideRelsFor()` only ever emitted the image relationship:
   ```ts
   // before — broken:
   return `<Relationships ...>
       <Relationship Id="rId1" Type=".../relationships/image" Target="../media/image${index}.${ext}"/>
   </Relationships>`;
   ```
   A slide with no resolvable layout is structurally incomplete, not just missing optional metadata — this is what Keynote was actually rejecting. Fixed by adding the layout relationship as `rId1` and shifting the image to `rId2` (and updating `slideXml()`'s `<a:blip r:embed="rId2"/>` to match):
   ```ts
   return `<Relationships ...>
       <Relationship Id="rId1" Type=".../relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
       <Relationship Id="rId2" Type=".../relationships/image" Target="../media/image${index}.${ext}"/>
   </Relationships>`;
   ```

2. `p:txStyles` was missing from `slideMaster1.xml` entirely — added a minimal `titleStyle`/`bodyStyle`/`otherStyle` block. Real PowerPoint always emits this; it's schema-optional but apparently not importer-optional.

3. `docProps/core.xml` and `docProps/app.xml` (Dublin Core title/dates, extended properties with slide count) were entirely absent, along with `ppt/presProps.xml`, `ppt/viewProps.xml`, `ppt/tableStyles.xml`, and `<p:defaultTextStyle>` in `presentation.xml` — all parts real PowerPoint always writes. Added all of them, each registered in `[Content_Types].xml` and the relevant `_rels` file.

Verified fixed by regenerating both a minimal synthetic file and the exact real 4-slide/colon-in-title scenario that originally failed, opening both in real Keynote via the same harness, twice each — both opened cleanly.

**One side effect worth knowing**: the deck's title now flows into the exported file's actual metadata (`docProps/core.xml`'s `<dc:title>`) — `export.ts` reads `presentation.title` from SQLite and passes it through to `assemblePptxFromImages(imagePaths, outputPath, title)`. Previously the title was only used for the save-dialog's suggested filename.

## 4. Editor UI: element-selection-to-chat and layout redesign

Two things ported from presenton's actual frontend rather than rebuilt from scratch — see `hypatia-frontend` git log for the diff (`PresentingPanel.tsx`, `ScaledSlideStage.tsx`, `editor/events/events.ts`).

**Slide preview scaling**: the editor's main slide preview and sidebar thumbnails render a fixed 1280×720 canvas (`TemplateV2KonvaSlide`) but nothing scaled it to fit its container — the sidebar showed raw extracted text instead of a thumbnail, and the main preview overflowed/clipped. Presenton's own frontend already solves this (`PresentationRender.tsx`'s `SlideScale`: `ResizeObserver` on the container → `scale = min(box.w/1280, box.h/720)` → `transform: scale(...)` on a 1280×720-native inner box) — hypatia had this exact pattern half-ported (`presentation/components/SlideContent.tsx`/`SlideThumbnailCard.tsx`, byte-identical to presenton) but the component that computes the scale was a no-op stub, and none of it was wired into the live `PresentingPanel.tsx`. New `ScaledSlideStage.tsx` implements the real scale math and gets used directly by the live component tree.

**Element selection → chat context**: `TemplateV2KonvaSlide` already dispatches a `presenton:template-v2-surface-selected` window event with `componentId`/`elementPath`/label info on every canvas selection change (`editor/events/events.ts`) — this existed and worked, just had no listener anywhere reachable from the live panel. `PresentingPanel.tsx` now listens for it: selecting an element shows a removable "Slide N: `<label>`" chip next to the always-present "Slide N" chip, and both get inlined as plain text ahead of the user's message when sent to `chatEdit()`:

```ts
const contextLines: string[] = [`UI context: this edit applies to slide ${selectedSlide + 1}.`];
if (selectedElement && selectedElement.slideIndex === selectedSlide) {
  contextLines.push(
    `The user selected "${selectedElement.label}" on this slide — edit that element/component specifically; preserve unrelated elements.`,
  );
}
const composedMessage = [...contextLines, `User message: ${chatMessage.trim()}`].join("\n");
```

This matches presenton's own approach exactly (`Chat.tsx`'s `buildBackendMessage()`) — there's no separate wire-protocol field for "scope," the backend only ever sees the `message` string, so client-side text injection is how presenton does it too, not a shortcut taken here.

**Visual redesign**: sidebar thumbnails restyled to number-left-of-thumbnail with a purple selected ring (matching presenton's `SlideThumbnailCard.tsx` structure), the AI panel got a "New chat" button, a centered "What can I do for your deck today?" empty state, and a quick-prompt pill row (`Rewrite for executives`, `Improve slide layout`, etc. — presenton's own `editorQuickPrompts` list). Uses hypatia's existing design tokens (`primary`, `border`, `muted-foreground`) rather than presenton's hardcoded hex values, so it stays theme-consistent (dark mode included) instead of being a literal pixel copy.

## Verification

- Backend: `pnpm run typecheck` + `pnpm run test` (161 tests) green throughout.
- Frontend: `pnpm run typecheck` + `pnpm run test` (504 tests) green throughout.
- Export fix: verified against real Keynote via the AppleScript harness described in §3, not just static validators.
- Imported Template pipeline: verified against a real sample `.pptx` end-to-end (extraction → stub-model vision step → orchestrator → storage → fed back through the *actual* renderer, `buildTemplateLayoutModel`, with zero renderer changes needed — the core promise of `docs/adr/0001-imported-template-full-schema-parity.md`).
- Not verified: the editor UI redesign and element-selection feature haven't been seen running in a real GUI (no display in this environment) — worth a visual pass before considering this fully done.
