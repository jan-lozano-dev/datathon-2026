import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { PLUGIN_ID_PATTERN, parsePluginManifest } from "../core/plugins.ts";
import type { PluginBackendContext, PluginBackendModule, PluginCleanup, PluginInfo, PluginNotification } from "../core/plugins.ts";
import { safePluginDataDirectory } from "../store/plugin-data-paths.ts";

/**
 * The minimal host for the app's built-in plugins (in this build: Flashcards).
 * Built-in packages are always enabled. There is no community folder, no
 * install, rescan or toggle, and no agent, model, worker or learning-graph
 * capability: a backend gets its data folder, named operations and
 * frontend notifications only.
 */

/** Expected host/transport failure. Exceptions thrown by plugin handlers stay ordinary 500 errors. */
export class PluginHostError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message); this.name = "PluginHostError";
		Object.defineProperty(this, Symbol.for("learnharness.plugin-host-error"), { value: true });
	}
}
/** Works across Next module instances holding the same process-global host. */
export function isPluginHostError(error: unknown): error is { status: number; message: string } {
	if (!error || typeof error !== "object") return false;
	try {
		const value = error as Record<string | symbol, unknown>;
		return value[Symbol.for("learnharness.plugin-host-error")] === true &&
			typeof value.message === "string" && typeof value.status === "number" &&
			[400, 404, 409, 413, 500, 503].includes(value.status);
	} catch { return false; }
}

export interface PluginHostDependencies {
	/** App-owned flat built packages and a separate writable data root. */
	core: { directory: string; dataDirectory: string; ids: readonly string[] };
	appVersion: string;
	onChange?: () => void;
	onNotification?: (notification: PluginNotification) => void;
}
interface Activation {
	controller: AbortController;
	cleanups: PluginCleanup[];
	handlers: Map<string, (input: unknown) => unknown | Promise<unknown>>;
	ready: boolean;
}
interface Package {
	info: PluginInfo;
	directory: string;
	files: Map<string, Buffer>;
	activation?: Activation;
	backend?: PluginBackendModule;
	blocked?: boolean;
}
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const operationId = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const safeSegment = (p: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p);

function regularFile(root: string, relative: string): string {
	const segments = relative.split("/");
	if (!segments.every(safeSegment)) throw new Error("Invalid plugin file path");
	let current = root;
	if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error("Unsafe plugin directory");
	const realRoot = fs.realpathSync(/* turbopackIgnore: true */ root);
	for (let i = 0; i < segments.length; i++) {
		current = path.join(current, segments[i]!);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink() || (i === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error("Symlinks and non-files are not plugin assets");
		const real = fs.realpathSync(/* turbopackIgnore: true */ current);
		if (!real.startsWith(realRoot + path.sep)) throw new Error("Plugin file escapes its package");
	}
	return current;
}
function pluginRoot(directory: string): void {
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe plugin directory");
}
function snapshot(directory: string, id: string, appVersion: string): Package {
	pluginRoot(directory);
	const files = new Map<string, Buffer>();
	const manifestBytes = fs.readFileSync(/* turbopackIgnore: true */ regularFile(directory, "manifest.json"));
	const manifest = Object.freeze(parsePluginManifest(JSON.parse(manifestBytes.toString("utf8")), id, appVersion));
	function collect(relative: string): void {
		for (const name of fs.readdirSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ directory, relative)).sort()) {
			if (!safeSegment(name) || (!relative && name === "data")) continue;
			const file = relative ? `${relative}/${name}` : name;
			const stat = fs.lstatSync(path.join(directory, file));
			if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed in plugin package files: ${file}`);
			if (stat.isDirectory()) {
				if (file === "assets" || file.startsWith("assets/")) collect(file);
			} else if (stat.isFile()) files.set(file, fs.readFileSync(/* turbopackIgnore: true */ regularFile(directory, file)));
			else throw new Error(`Invalid plugin file: ${file}`);
		}
	}
	collect("");
	for (const entry of [manifest.main, manifest.backend, manifest.styles]) if (entry && !files.has(entry)) throw new Error(`Missing plugin entry: ${entry}`);
	const hash = createHash("sha256");
	for (const [file, bytes] of files) { hash.update(`${file.length}:${file}:${bytes.length}:`); hash.update(bytes); }
	return { directory, files, info: { id, origin: "core", manifest, enabled: true, status: "disabled", revision: hash.digest("hex") } };
}
const mimeTypes: Record<string, string> = {
	".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
	".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};

/** Injectable, trusted-local-code host. Importing this module does no IO. */
export function createPluginHost(deps: PluginHostDependencies) {
	const core = { ...deps.core, ids: Object.freeze([...deps.core.ids]) };
	if (new Set(core.ids).size !== core.ids.length || core.ids.some(id => typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id))) throw new Error("Invalid core plugin catalog");
	{
		const code = path.resolve(/* turbopackIgnore: true */ core.directory);
		const data = path.resolve(/* turbopackIgnore: true */ core.dataDirectory);
		const relative = path.relative(code, data);
		if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Core plugin data must be outside app-owned code");
	}
	const coreData = { directory: core.dataDirectory, ids: core.ids };
	const packages = new Map<string, Package>();
	let initialized = false, disposed = false;
	let serial: Promise<unknown> = Promise.resolve();
	let disposing: Promise<void> | undefined;
	const assertOpen = () => { if (disposed) throw new PluginHostError(503, "Plugin host is disposed"); };
	const change = () => { if (disposed) return; try { deps.onChange?.(); } catch { /* Observers do not own host lifecycle. */ } };
	const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
		const result = serial.then(fn); serial = result.catch(() => {}); return result;
	};
	const get = (id: string) => { const pkg = packages.get(id); if (!pkg) throw new PluginHostError(404, `Unknown plugin: ${id}`); return pkg; };
	const live = (pkg: Package, activation: Activation) => !disposed && pkg.activation === activation && !activation.controller.signal.aborted;

	async function deactivate(pkg: Package): Promise<string[]> {
		const activation = pkg.activation;
		if (!activation) return [];
		pkg.activation = undefined; // Invalidate callbacks BEFORE abort listeners and cleanup run.
		activation.ready = false;
		activation.handlers.clear();
		activation.controller.abort();
		const failures: string[] = [];
		for (const cleanup of activation.cleanups.splice(0).reverse()) {
			try { await cleanup(); } catch (e) { failures.push(errorText(e)); }
		}
		return failures;
	}
	async function activate(pkg: Package): Promise<void> {
		assertOpen();
		const manifest = pkg.info.manifest;
		if (!manifest || pkg.blocked) { pkg.info.status = "error"; return; }
		const activation: Activation = { controller: new AbortController(), cleanups: [], handlers: new Map(), ready: false };
		pkg.activation = activation;
		const requireLive = () => { if (!live(pkg, activation)) throw new Error("Plugin activation is no longer active"); };
		const cleanup = (fn: PluginCleanup) => {
			if (typeof fn !== "function") throw new Error("Plugin cleanup must be a function");
			if (live(pkg, activation)) activation.cleanups.push(fn);
			else { try { Promise.resolve(fn()).catch(() => {}); } catch { /* Late cleanup still gets a chance to release resources. */ } }
		};
		try {
			if (manifest.backend) {
				pluginRoot(pkg.directory);
				const dataDirectory = safePluginDataDirectory(manifest.id, coreData, true)!;
				const ctx: PluginBackendContext = {
					manifest, directory: pkg.directory, dataDirectory, signal: activation.controller.signal, cleanup,
					handle(name, handler) {
						requireLive();
						if (!operationId.test(name) || typeof handler !== "function") throw new Error("Invalid plugin operation id or handler");
						if (activation.handlers.has(name)) throw new Error(`Duplicate plugin operation: ${name}`);
						// Unique token prevents a stale unregister from deleting a replacement.
						const registered = (input: unknown) => handler(input);
						activation.handlers.set(name, registered);
						return () => { if (activation.handlers.get(name) === registered) activation.handlers.delete(name); };
					},
					events: {
						emit(topic, data) {
							if (!live(pkg, activation)) return;
							if (!operationId.test(topic)) throw new Error("Invalid plugin notification topic");
							try { deps.onNotification?.({ pluginId: manifest.id, topic, data }); } catch { /* Isolate observers. */ }
						},
					},
				};
				if (!pkg.backend) {
					const entry = regularFile(pkg.directory, manifest.backend);
					// This absolute runtime path is deliberately NOT an import/require in
					// Next's module graph. Ship scripts/plugin-loader.cjs alongside app.
					const sidecar = path.join(process.cwd(), "scripts", "plugin-loader.cjs");
					const nativeRequire = createRequire(sidecar);
					const loader = nativeRequire(sidecar) as { load(filename: string): PluginBackendModule };
					pkg.backend = loader.load(entry);
					if (!pkg.backend || typeof pkg.backend.activate !== "function") throw new Error("Plugin backend must export activate(context)");
				}
				const returned = await pkg.backend.activate(ctx);
				if (returned !== undefined) cleanup(returned);
			}
			if (!live(pkg, activation)) { await deactivate(pkg); pkg.info.status = "disabled"; return; }
			activation.ready = true;
			pkg.info.status = "active";
			delete pkg.info.error;
		} catch (e) {
			const failures = await deactivate(pkg);
			pkg.info.status = "error";
			pkg.info.error = [errorText(e), ...failures.map(f => `Cleanup: ${f}`)].join("; ");
		}
	}

	async function initializeInternal(): Promise<void> {
		assertOpen();
		if (initialized) return;
		for (const id of [...core.ids].sort()) {
			const root = path.join(/* turbopackIgnore: true */ core.directory, id);
			let pkg: Package;
			try {
				pluginRoot(core.directory);
				pkg = snapshot(root, id, deps.appVersion);
			} catch (e) {
				pkg = { directory: root, files: new Map(), info: { id, origin: "core", enabled: true, status: "error", error: errorText(e), revision: "" }, blocked: true };
			}
			packages.set(id, pkg);
			if (!pkg.blocked) await activate(pkg);
		}
		initialized = true; change();
	}

	return {
		initialize: () => enqueue(initializeInternal),
		list(): PluginInfo[] {
			assertOpen();
			return [...packages.values()].map(({ info }) => ({ ...info, ...(info.manifest ? { manifest: { ...info.manifest } } : {}) })).sort((a, b) => a.id.localeCompare(b.id));
		},
		async call(id: string, operation: string, input?: unknown): Promise<unknown> {
			assertOpen();
			const pkg = get(id), activation = pkg.activation;
			if (!activation?.ready || !live(pkg, activation)) throw new PluginHostError(409, "Plugin is unavailable");
			if (!operationId.test(operation)) throw new PluginHostError(400, "Invalid plugin operation id");
			const handler = activation.handlers.get(operation);
			if (!handler) throw new PluginHostError(404, `Unknown plugin operation: ${operation}`);
			return handler(input);
		},
		asset(id: string, segments: string[]): { bytes: Uint8Array; contentType: string } {
			assertOpen();
			const pkg = get(id), manifest = pkg.info.manifest;
			if (pkg.info.status !== "active" || !manifest || pkg.blocked) throw new PluginHostError(409, "Plugin assets are unavailable");
			if (!segments.length || !segments.every(safeSegment)) throw new PluginHostError(400, "Invalid plugin asset path");
			const file = segments.join("/");
			if (!(segments.length === 1 && (file === manifest.main || file === manifest.styles)) && !(segments.length > 1 && segments[0] === "assets")) throw new PluginHostError(404, "Plugin asset is not allowlisted");
			if (segments.some(s => s === "data") || file === manifest.backend) throw new PluginHostError(404, "Private plugin file");
			try {
				pluginRoot(core.directory);
				pluginRoot(pkg.directory); regularFile(pkg.directory, file);
			} catch { throw new PluginHostError(404, "Unknown or unsafe plugin asset"); }
			const bytes = pkg.files.get(file);
			if (!bytes) throw new PluginHostError(404, "Unknown plugin asset");
			return { bytes: Uint8Array.from(bytes), contentType: mimeTypes[path.extname(file).toLowerCase()] ?? "application/octet-stream" };
		},
		dispose(): Promise<void> {
			if (disposing) return disposing;
			disposed = true; // Immediately fence callers, including queued work.
			for (const pkg of packages.values()) pkg.activation?.controller.abort();
			disposing = enqueue(async () => {
				for (const pkg of packages.values()) { await deactivate(pkg); pkg.info.status = "disabled"; }
			});
			return disposing;
		},
	};
}
