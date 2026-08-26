import { send } from "../../protocol.js";
import { listSmartExamples } from "../services/smart-examples.js";

export async function handlePresentingListSmartExamples(cmd: Record<string, unknown>): Promise<void> {
	const id = String(cmd.id ?? "unknown");
	try {
		send({ type: "result", id, data: { examples: listSmartExamples() } });
	} catch (err) {
		send({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
	}
}
