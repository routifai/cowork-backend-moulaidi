import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings, saveSettings, settingsFilePath } from "./settings-store.js";

describe("settings-store", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hypatia-settings-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns {} when the file is absent", () => {
		expect(loadSettings(dir)).toEqual({});
	});

	it("returns {} when the file is corrupt", () => {
		writeFileSync(settingsFilePath(dir), "{ not valid json");
		expect(loadSettings(dir)).toEqual({});
	});

	it("returns {} when the file is a non-object payload", () => {
		writeFileSync(settingsFilePath(dir), JSON.stringify(["a", "b"]));
		expect(loadSettings(dir)).toEqual({});
	});

	it("persists and reads back a settings object", () => {
		saveSettings(dir, { defaultModel: "sonnet" });
		expect(loadSettings(dir)).toEqual({ defaultModel: "sonnet" });
	});

	it("creates the settings directory if missing", () => {
		const nested = join(dir, "a", "b", "c");
		saveSettings(nested, { foo: "bar" });
		expect(loadSettings(nested)).toEqual({ foo: "bar" });
	});

	// The core regression: partial saves must MERGE, not overwrite. This is the
	// bug that wiped telemetry consent whenever the model was saved (and made
	// the consent popup reappear on every launch).
	it("merges partial updates without clobbering other keys", () => {
		saveSettings(dir, { telemetry: { enabled: true } });
		saveSettings(dir, { defaultModel: "sonnet", defaultProvider: "anthropic" });

		expect(loadSettings(dir)).toEqual({
			telemetry: { enabled: true },
			defaultModel: "sonnet",
			defaultProvider: "anthropic",
		});
	});

	it("saving a model does not erase telemetry consent", () => {
		saveSettings(dir, { telemetry: { enabled: false } });
		saveSettings(dir, { defaultModel: "gpt-5" });

		const settings = loadSettings(dir);
		expect(settings.telemetry).toEqual({ enabled: false });
	});

	it("replaces a top-level key when the same key is saved again", () => {
		saveSettings(dir, { defaultModel: "sonnet" });
		saveSettings(dir, { defaultModel: "opus" });
		expect(loadSettings(dir).defaultModel).toBe("opus");
	});

	it("writes pretty-printed JSON", () => {
		saveSettings(dir, { a: 1 });
		const raw = readFileSync(settingsFilePath(dir), "utf-8");
		expect(raw).toContain("\n");
	});
});
