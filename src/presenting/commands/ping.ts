import { send } from "../../protocol.js";

export async function handlePresentingPing(cmd: Record<string, unknown>): Promise<void> {
  send({ type: "result", id: cmd.id, data: { pong: true, status: "ok" } });
}
