# Presenton → Hypatia Template System: Gap Analysis

Date: 2026-08-22

## Context

Question raised: does hypatia's `presenting` feature have all the template JSON + assets it needs to build pptx from a template (default or user-provided)? Investigated by diffing the vendored upstream (`/Users/simo/hypatia/presenton`) against hypatia's port (`hypatia-backend/presenting`, `hypatia-backend/src/presenting`, `hypatia-frontend/public/presenting-templates`, `hypatia-frontend/src/presenting`).

## 1. Preset templates — fully ported, not a gap

All 8 bundled template packs (`dynamic`, `editorial`, `executive`, `general`, `modern`, `momentum`, `standard`, `swift`) are present in `hypatia-backend/presenting/engine/templates/<name>/template.json` + `.../static/*`, and are **byte-identical** to presenton's copies (confirmed via direct diff and file-size/asset-count comparison, e.g. `standard/template.json` diffs empty, `editorial` static assets 116/116 match).

Loader (`hypatia-backend/src/presenting/services/template-store.ts`) and the schema/binding logic (`template-schema.ts`, `template-binding.ts`, `template-content.ts`) are ported and structurally match presenton's `merged_components[] → variants[] → elements[]` model.

Frontend (`hypatia-frontend/public/presenting-templates/`) holds only the 8 picker thumbnails (no template.json/assets there) — correct, since the renderer reads template data backend-side.

**Conclusion: the reported symptom ("missing template json and assets") does not hold for preset templates.**

## 2. Gap: no custom-template pipeline (user-uploaded design templates)

Presenton has a second, separate subsystem: a user uploads their own `.pptx`, it's vision/LLM-analyzed (`templates/preview.py::upload_fonts_and_slides_preview_handler`, `templates/v2/generation`) into a new installable template with its own `template.json` + assets, stored as `TemplateV2` (`models/sql/template_v2.py`), exposed via `api/v1/ppt/endpoints/template.py` and frontend `app/(presentation-generator)/custom-template/`.

**Hypatia has none of this**:
- No backend command (`src/presenting/commands/` only has `chat-edit`, `edit-slide`, `export-presentation`, `get-presentation`, `parse-document`, `ping`, `start-generation`)
- No DB model equivalent to `TemplateV2`
- No frontend page (`custom-template` doesn't exist under `hypatia-frontend/src`)

This is a full feature absence, not a "code present, data missing" case.

**Terminology note**: hypatia's own `CONTEXT.md` defines "Uploaded Template" as a *content* source (docx/pdf whose text fills a preset design, via `parse-document.ts`) — a different concept from presenton's "custom template" (a pptx whose *visual design* becomes a new template). The doc explicitly says "avoid custom template — ambiguous with Preset Template," reading as a deliberate scope decision, not an oversight.

**Status**: flagged as a gap. Not being built now. If/when built: match presenton's vision/LLM-parse approach (reuse the proven extraction method into the same `merged_components`/`variants` schema used by presets) rather than a simpler XML-heuristic parser.

## 3. Gap: pptx export fidelity

Presenton's export renders native vector/shape reconstruction (browser-based: headless-Chromium render of `PdfMakerPage.tsx`, output as pdf or pptx per `export_as`).

Hypatia's `hypatia-backend/src/presenting/services/assemble-pptx.ts` is a deliberately simpler, from-scratch raster writer: one 16:9 slide per PNG, picture stretched to slide bounds, no pptxgenjs/python-pptx dependency.

**Tradeoff**: raster output loses text-selection, in-pptx editability, and searchability compared to presenton's native-shape output.

**Status**: flagged as a gap (design tradeoff, not an oversight — but worth being explicit that it's a real capability difference from upstream).

## Summary table

| Area | Status | Action |
|---|---|---|
| 8 preset templates (json + assets) | Complete, byte-identical to presenton | None — not a gap |
| Template schema/binding logic | Ported, structurally matches | None |
| Custom-template pipeline (upload pptx → new template) | Missing entirely | Flagged for future work; match presenton's vision/LLM approach if built |
| pptx export fidelity (raster vs vector) | Present but lower-fidelity than presenton | Flagged; intentional simplification, worth revisiting |
