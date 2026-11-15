/** Plugin API v1, as the M3Kang practice build hosts it: built-in plugins only
 * (Flashcards). Browser-safe contracts; runtime code is trusted local code.
 * No agent, model, worker, learning-graph, document or chat capability. */
export type * from "./plugin-ui.ts";
export type * from "./plugin-tree.ts";

export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Release activation/mount resources; the host accepts synchronous or async cleanup. */
export type PluginCleanup = () => void | Promise<void>;
export interface PluginManifest {
	apiVersion: 1;
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
	description?: string;
	author?: string;
	/** Bundled browser ES module. Entry paths must not address plugin data. */
	main?: string;
	/** Bundled Node CommonJS module. Node builtins are available. */
	backend?: string;
	styles?: string;
}
export interface PluginInfo {
	id: string;
	/** Host-owned package provenance: every package in this build is built in. */
	origin: "core";
	manifest?: PluginManifest;
	/** Built-in packages are always enabled; there is no toggle. */
	enabled: boolean;
	status: "disabled" | "active" | "error";
	error?: string;
	/** Changes only after server restart. */
	revision: string;
}
export interface PluginNotification {
	pluginId: string;
	topic: string;
	data?: unknown;
}
/** Backend activation scope, once per plugin per server, not per window.
 * Trusted Node code must cooperate with cancellation; no forced process isolation. */
export interface PluginBackendContext {
	readonly manifest: PluginManifest;
	/** Absolute code directory: app core-plugins/<id>. */
	readonly directory: string;
	/** Writable records: <data>/core-plugin-data/<id>. */
	readonly dataDirectory: string;
	/** Aborted when this backend activation ends. */
	readonly signal: AbortSignal;
	/** Register resource cleanup for deactivation, also supported as activate's return value. */
	cleanup(dispose: PluginCleanup): void;
	/** Register a named operation for this plugin's frontend call bridge. Inputs and
	 * results must be JSON-compatible; validate input in the handler. Returns unregister. */
	handle(name: string, handler: (input: unknown) => unknown | Promise<unknown>): () => void;
	events: {
		/** Notify this plugin's frontend listeners in connected windows. No persistence or replay. */
		emit(topic: string, data?: unknown): void;
	};
}
export interface PluginBackendModule {
	activate(context: PluginBackendContext): void | PluginCleanup | Promise<void | PluginCleanup>;
}
export interface PluginView {
	id: string;
	name: string;
	/** Mount only the view body; the host owns title and top bar. Departure aborts
	 * this mount signal. Return sync/async cleanup. */
	mount(container: HTMLElement, signal: AbortSignal): void | PluginCleanup | Promise<void | PluginCleanup>;
}
/** Frontend activation scope, once per plugin per window. */
export interface PluginFrontendContext {
	readonly manifest: PluginManifest;
	readonly signal: AbortSignal;
	cleanup(dispose: PluginCleanup): void;
	/** Register a plugin-owned body view; the app navigation links it. Returns unregister. */
	registerView(view: PluginView): () => void;
	/** Register a lazy settings-body mount, shown from the view's settings button. */
	registerSettings(mount: PluginView["mount"]): () => void;
	/** Controlled host widgets/overlays. */
	readonly ui: import("./plugin-ui.ts").PluginUi;
	/** Invoke this plugin's named backend operation with JSON-compatible input. */
	call<T = unknown>(operation: string, input?: unknown): Promise<T>;
	/** Observe this plugin's live-only notifications; returns unsubscribe. */
	onNotification(listener: (event: PluginNotification) => void): () => void;
	/** Re-read authoritative state after connection resync; returns unsubscribe. */
	onResync(listener: () => void): () => void;
	/** Host navigation in this window. */
	app: {
		pathname(): string;
		openHome(): void;
		/** Navigate to this plugin's registered view ID. */
		openView(id: string): void;
		openSettings(): void;
	};
}
export interface PluginFrontendModule {
	activate(context: PluginFrontendContext): void | PluginCleanup | Promise<void | PluginCleanup>;
}

/** No loosely coercing malformed manifests or executing incompatible packages. */
export function parsePluginManifest(value: unknown, folder: string, appVersion: string): PluginManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest.json must be an object");
	const m = value as Record<string, unknown>;
	if (!PLUGIN_ID_PATTERN.test(folder) || m.id !== folder) throw new Error("Plugin id must match its lowercase-hyphen folder name");
	if (m.apiVersion !== PLUGIN_API_VERSION) throw new Error("Unsupported plugin apiVersion (expected 1)");
	for (const key of ["name", "version", "minAppVersion"] as const) {
		if (typeof m[key] !== "string" || !m[key].trim()) throw new Error(`Manifest ${key} is required`);
	}
	const version = (s: unknown): number[] => {
		if (typeof s !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(s)) throw new Error("Versions must have three numeric components (x.y.z)");
		return s.split(".").map(Number);
	};
	version(m.version);
	const required = version(m.minAppVersion), actual = version(appVersion);
	for (let i = 0; i < 3; i++) {
		if (actual[i]! > required[i]!) break;
		if (actual[i]! < required[i]!) throw new Error(`Requires LearnHarness ${m.minAppVersion} or newer`);
	}
	for (const key of ["description", "author"] as const) {
		if (m[key] !== undefined && typeof m[key] !== "string") throw new Error(`Manifest ${key} must be a string`);
	}
	for (const [key, ext] of [["main", ".js"], ["backend", ".cjs"], ["styles", ".css"]] as const) {
		if (m[key] !== undefined && (typeof m[key] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(m[key]) || !m[key].endsWith(ext))) throw new Error(`Manifest ${key} must name a root ${ext} file`);
	}
	if (!m.main && !m.backend) throw new Error("A plugin needs a main or backend entry");
	if (m.styles && !m.main) throw new Error("styles requires a frontend main entry");
	return { apiVersion: 1, id: folder, name: m.name as string, version: m.version as string, minAppVersion: m.minAppVersion as string,
		...(m.description !== undefined ? { description: m.description as string } : {}), ...(m.author !== undefined ? { author: m.author as string } : {}),
		...(m.main ? { main: m.main as string } : {}), ...(m.backend ? { backend: m.backend as string } : {}), ...(m.styles ? { styles: m.styles as string } : {}) };
}
