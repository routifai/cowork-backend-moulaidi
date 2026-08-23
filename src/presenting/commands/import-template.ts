/**
 * Handler for the `presenting_import_template` command: import a
 * user-uploaded .pptx as a new Imported Template.
 */
import { existsSync } from "fs";
import { send, logError } from "../../protocol.js";
import type { HandlerDependencies } from "../../commands/handler-registry.js";
import { importTemplateFromPptx, TemplateImportError } from "../services/import-template-orchestrator.js";
import { ExportRuntimeError } from "../services/export-runtime.js";
import { IMPORTED_TEMPLATE_PREFIX } from "../services/template-resolver.js";

export async function handlePresentingImportTemplate(deps: HandlerDependencies, cmd: Record<string, unknown>): Promise<void> {
	const cmdId = String(cmd.id ?? "unknown");
	const pptxPath = String(cmd.pptxPath ?? cmd.pptx_path ?? "");
	const provider = String(cmd.provider ?? "");
	const model = String(cmd.model ?? "");

	const missing = [
		...(pptxPath ? [] : ["pptxPath"]),
		...(provider ? [] : ["provider"]),
		...(model ? [] : ["model"]),
	];
	if (missing.length) {
		send({ type: "result", id: cmdId, data: { error: `presenting_import_template requires: ${missing.join(", ")}` } });
		return;
	}
	if (!existsSync(pptxPath)) {
		send({ type: "result", id: cmdId, data: { error: `File not found: ${pptxPath}` } });
		return;
	}

	try {
		const meta = await importTemplateFromPptx(deps, {
			pptxPath,
			name: typeof cmd.name === "string" ? cmd.name : undefined,
			provider,
			model,
		});
		send({ type: "result", id: cmdId, data: { ...meta, id: `${IMPORTED_TEMPLATE_PREFIX}${meta.id}` } });
	} catch (exc) {
		if (exc instanceof TemplateImportError || exc instanceof ExportRuntimeError) {
			send({ type: "result", id: cmdId, data: { error: String(exc.message) } });
		} else {
			logError("presenting_import_template[%s]: %s", cmdId, exc instanceof Error ? exc.message : String(exc));
			send({ type: "result", id: cmdId, data: { error: exc instanceof Error ? exc.message : String(exc) } });
		}
	}
}
