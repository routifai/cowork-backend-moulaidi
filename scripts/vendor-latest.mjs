// Check (and optionally adopt) the latest stable release of tag-pinned vendored
// deps — so we never hardcode "whatever commit" and only move to verified
// releases on purpose.
//
//   node scripts/vendor-latest.mjs          # report only (CI-friendly check)
//   node scripts/vendor-latest.mjs --write  # bump manifest tag + re-lock
//
// "Latest stable" = GitHub's `repos/:repo/releases/latest` endpoint, which
// excludes prereleases and drafts. Bumping rewrites the `tag:` pin in
// fetch-vendor.mjs AND the resolved SHA in vendor.lock.json; both land in a
// reviewed PR, keeping the build reproducible and the upgrade auditable.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VENDORED, readLock, resolveTagSha, writeLock } from "./fetch-vendor.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(scriptsDir, "fetch-vendor.mjs");
const write = process.argv.includes("--write");

/** Latest non-prerelease, non-draft release tag for a GitHub repo, via gh. */
function latestRelease(repoSlug) {
	try {
		return execSync(`gh api repos/${repoSlug}/releases/latest --jq .tag_name`, {
			encoding: "utf-8",
		}).trim();
	} catch (err) {
		throw new Error(
			`could not query latest release for ${repoSlug} (is \`gh\` authed?): ${err.message}`,
		);
	}
}

/** Replace the `tag:` value for a named entry in the manifest source. */
function rewriteManifestTag(name, newTag) {
	let src = readFileSync(MANIFEST, "utf-8");
	// Match the `name: "<name>"` block, then its first `tag: "..."` line.
	const block = new RegExp(`(name:\\s*"${name}"[\\s\\S]*?tag:\\s*")([^"]+)(")`);
	if (!block.test(src)) throw new Error(`could not find tag pin for "${name}" in ${MANIFEST}`);
	src = src.replace(block, `$1${newTag}$3`);
	writeFileSync(MANIFEST, src, "utf-8");
}

const lock = readLock();
let changed = false;
let outdated = false;

for (const v of VENDORED) {
	if (!v.tag) continue; // commit-pinned third-party deps are out of scope
	if (!v.releaseRepo) {
		console.log(`[vendor:latest] ${v.name}: no releaseRepo configured — skipping`);
		continue;
	}

	const latest = latestRelease(v.releaseRepo);
	if (latest === v.tag) {
		console.log(`[vendor:latest] ${v.name}: up to date at ${v.tag}`);
		continue;
	}

	outdated = true;
	console.log(`[vendor:latest] ${v.name}: ${v.tag} → ${latest} available`);

	if (write) {
		const sha = resolveTagSha(v.repo, latest);
		rewriteManifestTag(v.name, latest);
		lock[v.name] = { ref: latest, sha };
		changed = true;
		console.log(`[vendor:latest] ${v.name}: pinned ${latest} (${sha.slice(0, 9)})`);
	}
}

if (write && changed) {
	writeLock(lock);
	console.log(
		"[vendor:latest] manifest + lock updated. Re-run `npm install` (or `node scripts/fetch-vendor.mjs`) to re-vendor, then commit the diff.",
	);
} else if (!write && outdated) {
	console.log("[vendor:latest] run with --write to adopt the latest release.");
	process.exitCode = 1; // non-zero so CI can flag drift if desired
}
