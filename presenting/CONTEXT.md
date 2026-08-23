# Presenting

The Hypatia PowerPoint Builder's backend: a standalone Python engine, ported from the open-source Presenton project, that turns a prompt or an uploaded document into an editable presentation. Encapsulated in this folder so the feature can be removed by deleting it plus a small number of integration points.

## Language

**Presenting Engine**:
The Python process itself — owns generation-pipeline orchestration (outline → content → layout selection), chat-based iterative slide editing, template-upload parsing, Chromium-based export rendering, and `.pptx` read/write. Holds no model credentials; see [Cowork](../CONTEXT.md)'s "Sidecar" term and this map's Relationships for how model calls actually get executed.
_Avoid_: "the sidecar" — that name is already Cowork's, and two same-named processes owned by the same Rust host is the exact collision this note exists to prevent. Also avoid "the PPT service."

**Preset Template**:
One of the 8 bundled slide-design packs (`dynamic`, `editorial`, `executive`, `general`, `modern`, `momentum`, `standard`, `swift`) shipped with the feature. Keeps its own self-contained visual styling — colors, fonts, layout CSS — independent of Hypatia's own design tokens.
_Avoid_: "theme" (a per-presentation color/font override applied on top of a template, a different concept), "layout" (a single slide's structural type within a template, one level down from Preset Template).

**Uploaded Template**:
A user-supplied source document, in whatever format the Presenting Engine's document-extraction step can parse, used as the starting structure a generated presentation gets filled into. The other of the two entry paths, alongside picking a Preset Template.
_Avoid_: "custom template" — ambiguous with Preset Template. Also avoid confusing with Imported Template — this term is about *content* (text poured into an existing design), not a *design* the user brings in.

**Imported Template**:
A new template a user creates by uploading their own `.pptx`; the Presenting Engine vision/LLM-analyzes it and produces a template.json + assets in the same shape as a Preset Template (`merged_components[] → variants[] → elements[]`), so the rendering/binding code (`template-schema.ts`, `template-binding.ts`) needs no changes to consume it. Scoped to the workspace that imported it — listed separately from the global Preset Template catalog, never merged into it.
_Avoid_: "custom template" (same collision reason as Uploaded Template) and "uploaded template" (already means the content-fill concept above, not a design import).
