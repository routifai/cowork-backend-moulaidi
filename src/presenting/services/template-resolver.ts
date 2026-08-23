/**
 * Dispatches a template id to either the Preset Template store (shipped,
 * global, id = bare name like "general") or the Imported Template store
 * (user-generated, workspace-scoped, id = "imported:<uuid>").
 *
 * Kept as its own module rather than folded into template-store.ts so the
 * Preset/Imported distinction stays explicit in code, not just in prose
 * (see hypatia-backend/presenting/CONTEXT.md).
 */
import { hypatiaAgentDir } from "../../agent-init.js";
import { getImportedTemplate } from "./imported-template-store.js";
import { getTemplate } from "./template-store.js";

export const IMPORTED_TEMPLATE_PREFIX = "imported:";

export interface TemplateResolutionContext {
	hypatiaDir: string;
	workspaceCwd: string;
}

export function isImportedTemplateId(templateId: string): boolean {
	return templateId.startsWith(IMPORTED_TEMPLATE_PREFIX);
}

export function resolveTemplateData(
	templateId: string,
	ctx: TemplateResolutionContext | undefined,
): Record<string, unknown> | null {
	if (isImportedTemplateId(templateId)) {
		if (!ctx) {
			throw new Error(
				`Cannot resolve Imported Template '${templateId}': no workspace context was provided`,
			);
		}
		const bareId = templateId.slice(IMPORTED_TEMPLATE_PREFIX.length);
		return getImportedTemplate(hypatiaAgentDir(ctx.hypatiaDir), ctx.workspaceCwd, bareId);
	}
	return getTemplate(templateId);
}
