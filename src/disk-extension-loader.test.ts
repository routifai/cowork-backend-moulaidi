import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeExtensionFactory, readPiPackages } from "./disk-extension-loader.js";

// ── readPiPackages ────────────────────────────────────────────────────

describe("readPiPackages", () => {
	it("returns [] when settings.json is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-empty-"));
		try {
			expect(readPiPackages(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the packages array from settings.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-pkgs-"));
		try {
			writeFileSync(
				join(dir, "settings.json"),
				JSON.stringify({
					packages: ["npm:pi-web-access", "git:github.com/foo/bar", "../local"],
					defaultModel: "sonnet",
				}),
			);
			expect(readPiPackages(dir)).toEqual([
				"npm:pi-web-access",
				"git:github.com/foo/bar",
				"../local",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("filters out non-string package entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-mixed-"));
		try {
			writeFileSync(
				join(dir, "settings.json"),
				JSON.stringify({ packages: ["npm:ok", { source: "npm:obj" }, 42, null] }),
			);
			// Only the plain string survives the string-only filter.
			expect(readPiPackages(dir)).toEqual(["npm:ok"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns [] on malformed JSON", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-bad-"));
		try {
			writeFileSync(join(dir, "settings.json"), "{ not valid json");
			expect(readPiPackages(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns [] when packages is missing or not an array", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-nopkgs-"));
		try {
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: "nope" }));
			expect(readPiPackages(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ── makeExtensionFactory ──────────────────────────────────────────────

describe("makeExtensionFactory", () => {
	it("returns a function (deferred loader) without importing eagerly", () => {
		// Building the factory must NOT touch the filesystem/jiti — loading is
		// deferred until the resource loader invokes it. A nonexistent path is
		// therefore fine at construction time.
		const factory = makeExtensionFactory("/does/not/exist/ext.ts");
		expect(typeof factory).toBe("function");
	});

	it("rejects with the real entry path when the module cannot be loaded", async () => {
		const factory = makeExtensionFactory("/does/not/exist/ext.ts");
		const fakeApi = {} as Parameters<typeof factory>[0];
		await expect(factory(fakeApi)).rejects.toThrow("/does/not/exist/ext.ts");
	});

	it("loads a real extension module and invokes its default factory", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ext-"));
		try {
			const entry = join(dir, "ext.ts");
			// Minimal extension: default-exported factory that calls a method on
			// the provided api. No pi/typebox imports, so it loads via jiti alone.
			writeFileSync(
				entry,
				"export default async function(pi){ pi.registerTool({ name: 'demo' }); }\n",
			);
			const calls: string[] = [];
			const fakeApi = {
				registerTool: (t: { name: string }) => calls.push(t.name),
			} as unknown as Parameters<ReturnType<typeof makeExtensionFactory>>[0];
			await makeExtensionFactory(entry)(fakeApi);
			expect(calls).toEqual(["demo"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects when the module has no default-exported function", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-nofac-"));
		try {
			const entry = join(dir, "bad.ts");
			writeFileSync(entry, "export const notDefault = 1;\n");
			const fakeApi = {} as Parameters<ReturnType<typeof makeExtensionFactory>>[0];
			await expect(makeExtensionFactory(entry)(fakeApi)).rejects.toThrow(
				"no default-exported factory",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
