/**
 * The LH_DATA_DIR seam: when set, every mutable record (practice database,
 * flashcards store, linked M3Kang bank) relocates under it; when unset, the
 * repo's data/. Pin both directions.
 *
 * The seam is evaluated at MODULE LOAD, so the "set" case must set the env
 * BEFORE the first import of config.ts in this process (dynamic import,
 * below) and the "unset" case needs a fresh child process.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TSX_LOADER = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

describe("LH_DATA_DIR seam", () => {
	it("relocates data under LH_DATA_DIR, and the practice database and flashcards with it", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-seam-"));
		process.env.LH_DATA_DIR = dir;
		try {
			const { PATHS, ROOT } = await import("../config.ts");
			assert.equal(PATHS.data, dir, "PATHS.data resolves the env value (resolved absolute)");
			assert.equal(PATHS.root, ROOT);
			const { practiceConfig } = await import("../src/server/practice.ts");
			const config = practiceConfig({});
			assert.equal(config.db, path.join(dir, "practice.db"));
			assert.equal(config.images, path.join(dir, "m3kang", "images"));
			assert.equal(config.bridge, path.join(ROOT, "practice", "bridge.py"));
		} finally {
			delete process.env.LH_DATA_DIR;
		}
	});

	it("unset = the repo data/ exactly as before (fresh child process, no env)", () => {
		const out = execFileSync(
			process.execPath,
			["--import", TSX_LOADER, "--eval", `const m = await import(${JSON.stringify(path.join(REPO_ROOT, "config.ts"))}); console.log(JSON.stringify({ data: m.PATHS.data }));`],
			{ cwd: REPO_ROOT, encoding: "utf-8" },
		);
		const parsed = JSON.parse(out) as { data: string };
		assert.equal(parsed.data, path.join(REPO_ROOT, "data"));
	});
});