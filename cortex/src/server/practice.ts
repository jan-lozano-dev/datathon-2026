import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS, ROOT } from "../../config.ts";

/**
 * The M3Kang practice test: a thin pipe to practice/bridge.py, which wraps
 * the team's adaptive trainer (copilot/teach/trainer.py). Selection,
 * grading, the level estimate and persistence all happen in Python; this
 * module only fixes the configuration, runs one bridge process per request
 * and maps its errors to HTTP statuses. No model is called anywhere.
 *
 * Fixed local configuration (environment overrides, no settings UI):
 *   LH_M3KANG_DIR  folder with the problem JSONL files and images/
 *                  (default <data>/m3kang, e.g. a link to the demo set)
 *   LH_TRAINER_PY  the trainer file (default: ../copilot/teach/trainer.py in the team
 *                  repository, else ../../wt-teach/copilot/teach/trainer.py)
 *   LH_PYTHON      the interpreter (default python3)
 *   LH_EXPLANATIONS hand-written explanations, JSON {problem id: text}
 *                  (default <data>/explanations.json; optional)
 * The practice database lives at <data>/practice.db.
 */

export interface PracticeConfig {
	python: string;
	bridge: string;
	trainer: string;
	bank: string[];
	images: string;
	db: string;
	explanations: string;
}

export function practiceConfig(env: Record<string, string | undefined> = process.env): PracticeConfig {
	const dir = path.resolve(/* turbopackIgnore: true */ env.LH_M3KANG_DIR || path.join(/* turbopackIgnore: true */ PATHS.data, "m3kang"));
	let bank: string[] = [];
	try {
		bank = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().map((name) => path.join(/* turbopackIgnore: true */ dir, name));
	} catch { /* reported by the bridge as an empty bank */ }
	return {
		python: env.LH_PYTHON || "python3",
		bridge: path.join(ROOT, "practice", "bridge.py"),
		trainer: path.resolve(/* turbopackIgnore: true */ env.LH_TRAINER_PY || defaultTrainer()),
		bank,
		images: path.join(/* turbopackIgnore: true */ dir, "images"),
		db: path.join(/* turbopackIgnore: true */ PATHS.data, "practice.db"),
		explanations: path.resolve(/* turbopackIgnore: true */ env.LH_EXPLANATIONS || path.join(/* turbopackIgnore: true */ PATHS.data, "explanations.json")),
	};
}

/** The trainer next to this app in the team repository, else the teach worktree. */
function defaultTrainer(): string {
	const candidates = [
		path.join(/* turbopackIgnore: true */ ROOT, "..", "copilot", "teach", "trainer.py"),
		path.join(/* turbopackIgnore: true */ ROOT, "..", "..", "wt-teach", "copilot", "teach", "trainer.py"),
	];
	return candidates.find((file) => fs.existsSync(file)) ?? candidates[0]!;
}

export class PracticeError extends Error {
	constructor(public readonly status: number, public readonly code: string, message: string) {
		super(message);
		this.name = "PracticeError";
	}
}

const STATUS: Record<string, number> = { bad_request: 400, not_found: 404, conflict: 409, unavailable: 503, internal: 500 };
const TIMEOUT_MS = 20_000;

/** One request to the bridge; resolves with its reply minus the ok flag. */
export function callBridge(request: Record<string, unknown>, config = practiceConfig()): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const child = spawn(/* turbopackIgnore: true */ config.python, [config.bridge], {
			cwd: ROOT,
			env: {
				NODE_ENV: process.env.NODE_ENV,
				PATH: process.env.PATH ?? "",
				LANG: process.env.LANG ?? "C.UTF-8",
				PYTHONIOENCODING: "utf-8",
				PYTHONDONTWRITEBYTECODE: "1",
				LH_TRAINER_PY: config.trainer,
				LH_BANK: config.bank.join(path.delimiter),
				LH_IMAGES: config.images,
				LH_PRACTICE_DB: config.db,
				LH_EXPLANATIONS: config.explanations,
			},
			stdio: "pipe",
		});
		let stdout = "", stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new PracticeError(503, "unavailable", `Could not start ${config.python}: ${error.message}`));
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			let reply: { ok?: boolean; error?: { code?: string; message?: string } } & Record<string, unknown>;
			try {
				reply = JSON.parse(stdout);
			} catch {
				if (stderr.trim()) console.error("[practice] bridge stderr:", stderr.trim());
				const why = signal === "SIGKILL" ? "timed out" : `exited with code ${code}`;
				reject(new PracticeError(500, "internal", `The practice service ${why}.`));
				return;
			}
			if (!reply.ok) {
				const errorCode = reply.error?.code ?? "internal";
				if (errorCode === "internal" || errorCode === "unavailable") console.error("[practice]", reply.error?.message);
				reject(new PracticeError(STATUS[errorCode] ?? 500, errorCode, reply.error?.message ?? "Practice request failed."));
				return;
			}
			const { ok: _ok, ...rest } = reply;
			resolve(rest);
		});
		child.stdin.end(JSON.stringify(request));
	});
}

/** A route's JSON reply, with bridge errors mapped to their status. */
export async function practiceResponse(request: Record<string, unknown>): Promise<Response> {
	try {
		return Response.json(await callBridge(request), { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		if (error instanceof PracticeError) {
			return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { "Cache-Control": "no-store" } });
		}
		console.error("[practice]", error);
		return Response.json({ error: { code: "internal", message: "Practice request failed." } }, { status: 500 });
	}
}

/** A JSON object body, or null when the body is not one. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
	try {
		const value: unknown = await request.json();
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

const IMAGE_KEY = /^([A-Za-z0-9._-]{1,80})\|([a-z]{2,8})$/;

/** The image file for a problem key (id|language), only inside the images folder. */
export function practiceImagePath(key: string, config = practiceConfig()): string | null {
	const match = IMAGE_KEY.exec(key);
	if (!match) return null;
	let root: string;
	try {
		root = fs.realpathSync(config.images);
	} catch {
		return null;
	}
	const file = path.join(/* turbopackIgnore: true */ root, `${match[1]}_${match[2]}.png`);
	try {
		const real = fs.realpathSync(file);
		return path.dirname(real) === root && fs.statSync(real).isFile() ? real : null;
	} catch {
		return null;
	}
}
