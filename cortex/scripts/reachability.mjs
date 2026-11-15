// Lists source modules that no kept entry point can reach. Used while cutting
// the app down to the M3Kang practice build: delete only what this proves
// unreachable, never whole directories by name.
//
//   node scripts/reachability.mjs            # unreachable files
//   node scripts/reachability.mjs --why FILE # one import chain to FILE
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SCAN = ["app", "components", "src", "lib", "electron", "public"];
const EXT = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".d.mts", ".json", ".md", ".css"];
const CODE = /\.(ts|tsx|js|mjs|cjs)$/;

function walk(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(file, out); }
		else out.push(file);
	}
	return out;
}

function resolve(from, spec) {
	let base;
	if (spec.startsWith("@/")) base = path.join(root, spec.slice(2));
	else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
	else return null;
	const candidates = [base, ...EXT.map(e => base + e), ...[".ts", ".tsx", ".js"].map(e => path.join(base, "index" + e))];
	if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"));
	for (const c of candidates) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
	return null;
}

const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)|new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\)|import\(["']([^"']+)["']\)\.\w+/g;

function deps(file) {
	if (!CODE.test(file)) return [];
	const text = fs.readFileSync(file, "utf8");
	const out = [];
	for (const m of text.matchAll(IMPORT)) {
		const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
		const target = spec && resolve(file, spec);
		if (target) out.push(target);
	}
	return out;
}

const entries = [
	...walk(path.join(root, "app")),
	...["proxy.ts", "instrumentation.ts", "next.config.ts", "config.ts"].map(f => path.join(root, f)),
	path.join(root, "public", "plugin-loader.js"),
].filter(f => fs.existsSync(f));

const parent = new Map(entries.map(e => [e, null]));
const queue = [...entries];
while (queue.length) {
	const file = queue.shift();
	for (const dep of deps(file)) if (!parent.has(dep)) { parent.set(dep, file); queue.push(dep); }
}

const why = process.argv.indexOf("--why");
if (why > 0) {
	let file = path.resolve(process.argv[why + 1]);
	if (!parent.has(file)) { console.log("unreachable"); process.exit(0); }
	while (file) { console.log(path.relative(root, file)); file = parent.get(file); }
	process.exit(0);
}
const all = SCAN.flatMap(d => fs.existsSync(path.join(root, d)) ? walk(path.join(root, d)) : []);
for (const file of all.sort()) if (!parent.has(file)) console.log(path.relative(root, file));
