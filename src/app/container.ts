import type { ModelRegistry, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { createPromptScheduler } from "../prompt-scheduler.js";

/**
 * Mutable runtime state shared across command handlers.
 *
 * This container is intentionally a flat bag of state — the sidecar is
 * single-threaded by design and command handlers only touch these values
 * through the typed HandlerDependencies interface.
 */
export interface AppContainer {
	initialized: boolean;
	modelRuntime: ModelRuntime | undefined;
	modelRegistry: ModelRegistry | undefined;
	sessionManager: ReturnType<typeof SessionManager.inMemory> | undefined;
	settingsManager: ReturnType<typeof SettingsManager.inMemory> | undefined;
	session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	resourceLoader: DefaultResourceLoader | undefined;
	hypatiaDir: string;
	workspaceCwd: string;
	promptScheduler: ReturnType<typeof createPromptScheduler>;
}
