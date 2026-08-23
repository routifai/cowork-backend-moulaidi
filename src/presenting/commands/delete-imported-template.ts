/**
 * Handler for the `presenting_delete_imported_template` command.
 */
import { send, logError } from "../../protocol.js";
import type { HandlerDependencies } from "../../commands/handler-registry.js";
import { hypatiaAgentDir } from "../../agent-init.js";
import { deleteImportedTemplate } from "../services/imported-template-store.js";
import { IMPORTED_TEMPLATE_PREFIX } from "../services/template-resolver.js";

export async function handlePresentingDeleteImportedTemplate(deps: HandlerDependencies, cmd: Record<string, unknown>): Promise<void> {
	const cmdId = String(cmd.id ?? "unknown");
	const rawTemplateId = String(cmd.templateId ?? cmd.template_id ?? "");
	if (!rawTemplateId) {
		send({ type: "result", id: cmdId, data: { error: "presenting_delete_imported_template requires: templateId" } });
		return;
	}
	const templateId = rawTemplateId.startsWith(IMPORTED_TEMPLATE_PREFIX)
		? rawTemplateId.slice(IMPORTED_TEMPLATE_PREFIX.length)
		: rawTemplateId;
	try {
		const deleted = deleteImportedTemplate(hypatiaAgentDir(deps.hypatiaDir), deps.workspaceCwd, templateId);
		send({ type: "result", id: cmdId, data: { deleted } });
	} catch (exc) {
		logError("presenting_delete_imported_template[%s]: %s", cmdId, exc instanceof Error ? exc.message : String(exc));
		send({ type: "result", id: cmdId, data: { error: exc instanceof Error ? exc.message : String(exc) } });
	}
}
