/**
 * Workspace-scoped store for Imported Templates.
 *
 * An Imported Template is a user-uploaded .pptx whose visual design has been
 * vision/LLM-extracted into a template.json in the same shape a Preset
 * Template uses (merged_components[] -> variants[] -> elements[]). Unlike
 * Preset Templates (shipped, global, read-only, cached at module load — see
 * template-store.ts), Imported Templates are user-generated per-workspace
 * data: they live under the same root as memory notes, not under the
 * shipped presentingEngineRoot()/templatesDir().
 *
 * Layout:
 *   <baseDir>/presenting-imported-templates/<encoded-cwd>/index.json
 *   <baseDir>/presenting-imported-templates/<encoded-cwd>/<templateId>/template.json
 *   <baseDir>/presenting-imported-templates/<encoded-cwd>/<templateId>/static/*.png
 *
 * `baseDir` is hypatiaAgentDir(hypatiaDir) (see agent-init.ts), `cwd` is the
 * workspace path, encoded via memory-store.ts's encodeWorkspacePath so the
 * two features share one directory-naming convention.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { encodeWorkspacePath } from "../../memory-store.js";

export const IMPORTED_TEMPLATES_DIRNAME = "presenting-imported-templates";

export interface ImportedTemplateMeta {
	id: string;
	name: string;
	/** data:image/png;base64,... */
	thumbnail: string;
	slideCount: number;
	createdAt: string;
}

function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function rootDirForCwd(baseDir: string, cwd: string): string {
	return join(baseDir, IMPORTED_TEMPLATES_DIRNAME, encodeWorkspacePath(cwd));
}

function indexPath(baseDir: string, cwd: string): string {
	return join(rootDirForCwd(baseDir, cwd), "index.json");
}

function templateDir(baseDir: string, cwd: string, templateId: string): string {
	return join(rootDirForCwd(baseDir, cwd), templateId);
}

function loadIndex(baseDir: string, cwd: string): ImportedTemplateMeta[] {
	const fp = indexPath(baseDir, cwd);
	if (!existsSync(fp)) return [];
	try {
		return JSON.parse(readFileSync(fp, "utf-8")) as ImportedTemplateMeta[];
	} catch {
		return [];
	}
}

function writeIndex(baseDir: string, cwd: string, entries: ImportedTemplateMeta[]): void {
	ensureDir(rootDirForCwd(baseDir, cwd));
	writeFileSync(indexPath(baseDir, cwd), JSON.stringify(entries, null, 2), "utf-8");
}

export function listImportedTemplates(baseDir: string, cwd: string): ImportedTemplateMeta[] {
	return loadIndex(baseDir, cwd);
}

export function getImportedTemplate(baseDir: string, cwd: string, templateId: string): Record<string, unknown> | null {
	const jsonPath = join(templateDir(baseDir, cwd, templateId), "template.json");
	if (!existsSync(jsonPath)) return null;
	try {
		return JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export interface SaveImportedTemplateInput {
	name: string;
	templateJson: Record<string, unknown>;
	/** Thumbnail PNG bytes, and any other static assets referenced by templateJson. */
	staticAssets: { filename: string; data: Buffer }[];
	thumbnailFilename: string;
	slideCount: number;
}

/** Persist a newly-generated Imported Template. Returns its listing metadata. */
export function saveImportedTemplate(baseDir: string, cwd: string, input: SaveImportedTemplateInput): ImportedTemplateMeta {
	const templateId = uuidv4();
	const dir = templateDir(baseDir, cwd, templateId);
	const staticDir = join(dir, "static");
	ensureDir(staticDir);

	writeFileSync(join(dir, "template.json"), JSON.stringify(input.templateJson, null, 2), "utf-8");
	for (const asset of input.staticAssets) {
		writeFileSync(join(staticDir, asset.filename), asset.data);
	}

	const thumbnailAsset = input.staticAssets.find((a) => a.filename === input.thumbnailFilename);
	const thumbnail = thumbnailAsset ? `data:image/png;base64,${thumbnailAsset.data.toString("base64")}` : "";

	const meta: ImportedTemplateMeta = {
		id: templateId,
		name: input.name,
		thumbnail,
		slideCount: input.slideCount,
		createdAt: new Date().toISOString(),
	};

	const entries = loadIndex(baseDir, cwd);
	entries.push(meta);
	writeIndex(baseDir, cwd, entries);

	return meta;
}

/** Remove an Imported Template. Returns true if it existed. */
export function deleteImportedTemplate(baseDir: string, cwd: string, templateId: string): boolean {
	const entries = loadIndex(baseDir, cwd);
	const next = entries.filter((e) => e.id !== templateId);
	if (next.length === entries.length) return false;

	writeIndex(baseDir, cwd, next);

	const dir = templateDir(baseDir, cwd, templateId);
	if (existsSync(dir)) rmSync(dir, { recursive: true });

	return true;
}

/** @internal exposed for tests only */
export function _listTemplateIdsOnDisk(baseDir: string, cwd: string): string[] {
	const dir = rootDirForCwd(baseDir, cwd);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => existsSync(join(dir, name, "template.json")));
}
