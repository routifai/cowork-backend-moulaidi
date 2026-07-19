/**
 * Hypatia Cowork — Bundled npm configuration for the agent sidecar.
 *
 * In production the Tauri host exports `HYPATIA_BUNDLED_NPM_CLI` (absolute path
 * to the bundled `npm-cli.js`). We override pi's npm command so extension
 * installs work on machines with no system Node/npm, and pin the global prefix
 * to a user-writable directory so `npm install -g` doesn't try to write into a
 * root-owned app install dir (which fails with EACCES / exit code 243).
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Return the bundled Node + npm CLI command, or undefined in dev / when no
 * bundle is present so pi falls back to the system `npm` on PATH.
 *
 * Runs as: `<thisNode> --use-system-ca <npm-cli.js>`
 *   - `process.execPath` is the same bundled Node running this sidecar.
 *   - `--use-system-ca` is a real CLI arg (not NODE_OPTIONS, which older
 *     child Nodes reject) so npm trusts corporate MITM roots.
 */
export function bundledNpmCommand(
	env: NodeJS.ProcessEnv = process.env,
	execPath: string = process.execPath,
	exists: (p: string) => boolean = existsSync,
): string[] | undefined {
	const cli = env.HYPATIA_BUNDLED_NPM_CLI;
	if (!cli || !exists(cli)) return undefined;
	return [execPath, "--use-system-ca", cli];
}

/**
 * User-writable npm global prefix for the bundled npm.
 *
 * When npm runs next to a system-wide Node binary, it derives its global
 * prefix from that binary's location. For a `.deb`/AppImage/Windows install
 * that location is root-owned, so `npm install -g` fails. Point the prefix to
 * a per-user directory under home instead.
 *
 * Returns undefined in dev / when a user-configured prefix already exists.
 */
export function bundledNpmPrefix(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string | undefined {
	if (!env.HYPATIA_BUNDLED_NPM_CLI) return undefined;
	if (env.npm_config_prefix || env.NPM_CONFIG_PREFIX) return undefined;
	return join(home, ".hypatia-cowork", "npm-global");
}

/**
 * Ephemerally override pi's npm command with the bundled Node+npm WITHOUT
 * persisting an absolute, version-specific path into the user's settings.json
 * (which would go stale on the next app update and break the standalone pi
 * CLI). A user-configured `npmCommand` always wins.
 */
export function applyBundledNpm(settingsManager: SettingsManager): void {
	const bundled = bundledNpmCommand();
	if (!bundled) return;

	const prefix = bundledNpmPrefix();
	if (prefix) {
		try {
			mkdirSync(prefix, { recursive: true });
			process.env.npm_config_prefix = prefix;
		} catch {
			// If we can't create the prefix dir, leave npm's default behavior in
			// place rather than pointing it at a path it also can't use.
		}
	}

	const sm = settingsManager as unknown as { getNpmCommand(): string[] | undefined };
	const orig = sm.getNpmCommand.bind(sm);
	sm.getNpmCommand = () => {
		const configured = orig();
		return configured && configured.length > 0 ? configured : bundled;
	};
}
