import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file is at <root>/config.ts). */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * THE data-location seam: LH_DATA_DIR relocates every MUTABLE record — the
 * practice database, the flashcards store and the linked M3Kang bank — when
 * set. Unset it resolves to the repo's data/ (gitignored).
 */
// Mutable runtime paths are not deployment assets. Turbopack analyzes each
// path-producing call independently, so derived paths need their own opt-out.
const DATA_ROOT = process.env.LH_DATA_DIR
	? path.resolve(/* turbopackIgnore: true */ process.env.LH_DATA_DIR)
	: path.join(/* turbopackIgnore: true */ ROOT, "data");

export const PATHS = {
	root: ROOT,
	data: DATA_ROOT,
} as const;
