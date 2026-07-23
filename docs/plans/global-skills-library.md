# Global skills library + find_skill search tool

Status: planned, not started.
Scope: `hypatia-backend` only, plus one local machine config edit
(`~/.pi/agent/settings.json`). No frontend changes.

## Problem

The user wants a global (not per-project) library of skills — e.g. PowerPoint
authoring — where the agent can discover what's available by short metadata
(name + description) rather than having every skill's full instructions
dumped into context, with a dedicated search tool for when the library grows
large.

## What already exists (so this plan doesn't reinvent it)

`@earendil-works/pi-coding-agent` (the SDK this backend is built on) already
ships a complete, spec-compliant [Agent Skills](https://agentskills.io/specification)
implementation: `loadSkills()`/`loadSkillsFromDir()`/`formatSkillsForPrompt()`/
`Skill`/`SkillFrontmatter` are public exports
(`node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:21`). It scans
global (`~/.pi/agent/skills/`), project, package, and `settings.json`-declared
skill locations, and does exactly progressive disclosure: only short
`name`+`description` metadata is always in context (as an `<available_skills>`
XML block), full `SKILL.md` content loads on-demand via the agent's existing
`read` tool.

This is already wired into every Hypatia session globally today —
`src/agent-init.ts:162-179`'s `buildResourceLoader()` passes `agentDir:
piAgentDir()` (`~/.pi/agent`, global) into `DefaultResourceLoader`. Verified
(not assumed) that this listing actually reaches the model despite Hypatia's
custom system prompt: `agent-session.js`'s `_rebuildSystemPrompt()` calls
`buildSystemPrompt({ customPrompt: <Hypatia's override output>, skills:
resourceLoader.getSkills().skills, ... })`, and `system-prompt.js`'s
`customPrompt` branch unconditionally appends `formatSkillsForPrompt(skills)`
regardless of the custom prompt content — unlike tool `promptSnippet`/
`promptGuidelines`, which *are* silently discarded under Hypatia's custom
prompt (a different, already-known gotcha, not relevant here).

A real, well-formed skills library already sits on disk at
`/Users/simo/skills/` (pptx, docx, pdf, xlsx, webapp-testing,
frontend-design) — directly matching the user's own PowerPoint example.

There is a **pre-existing, unrelated, still-unimplemented** `search_skills`
RPC stub (`hypatia-frontend/src-tauri/src/lib.rs:1210`,
`hypatia-backend/src/commands/types.ts:199-216`). The `packument` naming
confirms it was scaffolded for browsing/installing pi *packages* from a
registry (a different, deferred epic) — not for querying `SKILL.md` content,
and has no backend handler at all. This plan's new tool is named `find_skill`
specifically to avoid colliding with that stub.

**Decision**: no Settings UI for browsing skills in this pass — skills are
managed by dropping files on disk, same as pi's own convention. A browse-only
panel (mirroring `MemorySettings.tsx`) is a named fast-follow, not silently
dropped.

## Steps

### 1. Zero-code baseline (configuration only) — corrected after real testing
- [x] Added `"skills": ["/Users/simo/skills"]` to `~/.pi/agent/settings.json`.
  Harmless and still useful for plain terminal `pi` usage, but **manual
  verification found this is inert for Hypatia specifically**:
  `hypatia-backend/src/app/bootstrap.ts:75` constructs `SettingsManager.inMemory({retry: {...}})`
  — entirely disconnected from the real `~/.pi/agent/settings.json` file on
  disk, except for `packages`, which is explicitly forwarded via
  `readPiPackages(piDir)` + `.setPackages(...)`. `skills` is never forwarded,
  so the settings.json edit alone changes nothing for Hypatia.
- [x] **Actual fix**: symlinked `~/.pi/agent/skills → /Users/simo/skills`.
  Confirmed via `resource-loader.js`'s `updateSkillsFromPaths()` that the
  default global skills directory (`<agentDir>/skills`) is scanned
  unconditionally by `PackageManager.resolve()`, independent of
  `SettingsManager` — the same mechanism that already makes
  `~/.pi/agent/extensions/` auto-discoverable regardless of settings. This
  is the one deviation from the original plan text, found only by actually
  running the real `buildResourceLoader()` path rather than trusting the
  settings.json edit.
- [x] Verified: ran the real `buildResourceLoader()` → `getSkills()` path (a
  throwaway script, since deleted) and confirmed all 16 skills from
  `/Users/simo/skills` are discovered, including `pptx`/`docx`/`pdf`/`xlsx`.
  Three harmless warnings for root-level `.md` files without frontmatter
  (`README.md`, `THIRD_PARTY_NOTICES.md`, `agent_skills_spec.md`) — expected,
  not skills, correctly skipped per the spec's "missing description" rule.

### 2. BM25 ranking function
- [x] Create `src/lib/bm25.ts` (+ `bm25.test.ts`): a small, pure, hand-rolled
  `rankBm25(query, documents)` — tokenize, per-term IDF across the corpus,
  TF-IDF with saturation and length normalization. No new dependency; the
  corpus is small (tens to a couple hundred skills at most). Kept separate
  from the tool file so the algorithm gets isolated unit tests, undiluted by
  I/O/tool-registration concerns (same separation already used for
  `memory-store.ts` vs `save-memory.ts`). 7/7 tests passing.

### 3. The `find_skill` tool
- [x] Create `src/extensions/find-skill.ts` (+ `find-skill.test.ts`),
  mirroring the `pi.registerTool({name, label, description, parameters,
  execute})` pattern from `show-artifact.ts`/`save-memory.ts` — the only two
  existing custom-tool examples in this repo.
  - Params: `{ query: string }`.
  - Execute: calls the SDK's own `loadSkills({ cwd: workspaceCwd, agentDir,
    skillPaths: [], includeDefaults: true })` directly — reusing the SDK's
    own loader, zero reimplementation of `SKILL.md` parsing/frontmatter
    validation — ranks each skill's `name + description` against the query
    via `rankBm25`, returns the top matches' `{name, description, filePath}`
    only, **never full content**. The model uses its existing `read` tool on
    the winning `filePath`.
  - `agentDir` is passed in via `FindSkillOptions` (computed by the caller),
    not hardcoded inside the tool — mirrors `save-memory.ts`'s
    `{baseDir, workspaceCwd}` injection pattern exactly, and is what makes
    the tool hermetically testable (a temp dir stands in for `~/.pi/agent`
    in tests, never touching the real global skills directory).
  - Tested with a temp directory (`mkdtempSync`) containing a few fake
    `SKILL.md` files: verifies ranking order, verifies unrelated skills are
    excluded, verifies an empty-match response isn't an error, and — the
    most important assertion — verifies the tool result's serialized JSON
    never contains skill body content. 4/4 tests passing, typecheck clean.

### 4. Wiring
- [x] `src/agent-init.ts`: register `find-skill` extension in
  `extensionFactories`, alongside `showArtifactExtension`/`saveMemoryExtension`.
  Wired as `(pi) => findSkillExtension(pi, { agentDir: piResourceDir,
  workspaceCwd })`, reusing the `piResourceDir` variable already computed a
  few lines above for the resource loader itself — no new path resolution.
- [x] Added one Guidelines bullet to `HYPATIA_SYSTEM_PROMPT`, matching the
  existing `show_artifact`/`save_memory` bullets' style. Typecheck clean.

### 5. Regression + end-to-end proof
- [x] `npx tsc --noEmit && npx vitest run` in `hypatia-backend` — 16 test
  files, 104 tests passing, typecheck clean.
- [x] Ran `find_skill`'s real ranking logic (`rankBm25` + the real
  `loadSkills()` output) against the actual 16-skill library with three
  realistic queries. Found and fixed a real bug in the process (see below).
  Results after the fix: "make me a PowerPoint presentation" → `pptx` alone;
  "extract text from a PDF form" → `pdf` on top; "test a web app with
  playwright" → `webapp-testing` on top.
- [x] **Real bug found and fixed**: before the fix, "make me a PowerPoint
  presentation" ranked `slack-gif-creator` *above* `pptx` — its description
  contains "make"/"me" (from an example phrase, "make me a GIF of X..."),
  and several weak matches on common filler words outscored pptx's one
  strong match on "powerpoint"/"presentation" in a longer document (BM25's
  length normalization further penalizes pptx's longer description). Fixed
  by adding a standard stopword list to `bm25.ts`'s tokenizer, applied
  symmetrically to both documents and queries. Pinned with a regression test
  in `bm25.test.ts` reproducing the exact failure using the real skill
  descriptions. Re-verified after the fix: `pptx` now ranks alone and
  correctly for the PowerPoint query.
- [ ] Not yet done: a real end-to-end chat prompt ("make me a PowerPoint
  about X") through the actual running Hypatia app, confirming the model
  itself calls `find_skill` or notices the listing and follows through to
  `read` the winning skill. Everything below the model's own tool-use
  decision is now verified; the model's own behavior in a live session is
  the one thing only a real run of the app can confirm.

## Explicitly out of scope (v1)
- No Settings → Skills browse UI.
- No changes to pi's own skill-loading, validation, or `/skill:name` command
  mechanism — already works, SDK-internal, nothing to build.
- No `disable-model-invocation` management — that's a per-skill frontmatter
  flag the skill author sets directly, not something `find_skill` exposes.
