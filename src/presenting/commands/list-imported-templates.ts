/**
 * Handler for the `presenting_list_imported_templates` command.
 */
import { send, logError } from "../../protocol.js";
import type { HandlerDependencies } from "../../commands/handler-registry.js";
import { hypatiaAgentDir } from "../../agent-init.js";
import { listImportedTemplates } from "../services/imported-template-store.js";
import { IMPORTED_TEMPLATE_PREFIX } from "../services/template-resolver.js";

export async function handlePresentingListImportedTemplates(deps: HandlerDependencies, cmd: Record<string, unknown>): Promise<void> {
	const cmdId = String(cmd.id ?? "unknown");
	try {
		const templates = listImportedTemplates(hypatiaAgentDir(deps.hypatiaDir), deps.workspaceCwd)
			.map((t) => ({ ...t, id: `${IMPORTED_TEMPLATE_PREFIX}${t.id}` }));
		send({ type: "result", id: cmdId, data: { templates } });
	} catch (exc) {
		logError("presenting_list_imported_templates[%s]: %s", cmdId, exc instanceof Error ? exc.message : String(exc));
		send({ type: "result", id: cmdId, data: { error: exc instanceof Error ? exc.message : String(exc) } });
	}
}
