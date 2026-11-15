import type { PluginCleanup, PluginFrontendContext, PluginFrontendModule, PluginInfo, PluginNotification, PluginView } from "@/src/core";
import type { PluginUi } from "@/src/core";

export type PluginMount = (container: HTMLElement, signal: AbortSignal) => ReturnType<PluginView["mount"]>;
export interface FrontendPlugin {
	info: PluginInfo;
	phase: "disabled" | "loading" | "active" | "error";
	error?: string;
	views: PluginView[];
	settings?: PluginView["mount"];
}
export interface PluginSnapshot {
	plugins: FrontendPlugin[];
	loading: boolean;
	error?: string;
}
interface Lifecycle {
	id: string;
	revision: string;
	controller: AbortController;
	cleanups: Set<PluginCleanup>;
	/** Activation and every cooperative mount/cleanup must settle before reuse. */
	activation: Promise<void>;
	tasks: Set<Promise<void>>;
	teardown?: Promise<void>;
	views: Map<string, PluginView>;
	settings?: PluginView["mount"];
	notifications: Set<(event: PluginNotification) => void>;
	resyncs: Set<() => void>;
	phase: "loading" | "active" | "error";
	error?: string;
}
export interface PluginHost {
	fetch: typeof fetch;
	importModule(url: string): Promise<PluginFrontendModule>;
	pathname(): string;
	navigate(path: string): void;
	openSettings?(pluginId: string): void;
	createUi?(options: { signal: AbortSignal; pluginId?: string; onError: (error: unknown) => void }): PluginUi;
	style?(url: string, onError: () => void): PluginCleanup;
}

export function pluginViewPath(pluginId: string, viewId: string): string {
	return `/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(viewId)}`;
}
export function pluginAssetUrl(info: PluginInfo, path: string): string {
	return `/api/plugins/${encodeURIComponent(info.id)}/assets/${encodeURIComponent(path)}?revision=${encodeURIComponent(info.revision)}`;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Pure per-window lifecycle owner for the built-in plugins. No React, polling,
 * or additional SSE source. A lifecycle object IS its activation generation:
 * every async continuation must still own that exact object before
 * registering or publishing anything. */
export class PluginFrontendManager {
	private infos: PluginInfo[] = [];
	private lives = new Map<string, Lifecycle>();
	private teardowns = new Map<string, Promise<void>>();
	private listeners = new Set<() => void>();
	private cleanupErrors = new Map<string, string>();
	private requestGeneration = 0;
	private disposed = false;
	private started = false;
	private snapshot: PluginSnapshot = { plugins: [], loading: true };
	constructor(private host: PluginHost) {}
	getSnapshot = () => this.snapshot;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};
	private publish(patch: Partial<PluginSnapshot> = {}) {
		if (this.disposed) return;
		this.snapshot = { ...this.snapshot, ...patch,
			plugins: this.infos.map(info => {
				const life = this.lives.get(info.id);
				return {
					info, phase: life?.phase ?? (info.status === "error" ? "error" : info.status === "active" ? "active" : "disabled"),
					error: life?.error ?? this.cleanupErrors.get(info.id) ?? info.error,
					views: [...(life?.views.values() ?? [])], settings: life?.settings,
				};
			}) };
		for (const listener of [...this.listeners]) listener();
	}
	start() {
		if (this.started || this.disposed) return;
		this.started = true;
		void this.reload();
	}
	private current(life: Lifecycle): boolean {
		return !this.disposed && !life.controller.signal.aborted && this.lives.get(life.id) === life;
	}
	private report(life: Lifecycle, error: unknown) {
		if (!this.current(life)) return;
		life.error = message(error);
		this.publish();
	}
	private disposeCallback(life: Lifecycle, cleanup: PluginCleanup) {
		const failed = (error: unknown) => {
			// Teardown errors remain visible while a replacement is waiting,
			// but an old orphan must not overwrite a newer active generation.
			const current = this.lives.get(life.id);
			if (this.disposed || (current && current !== life && current.phase !== "loading")) return;
			this.cleanupErrors.set(life.id, message(error)); this.publish();
		};
		try { this.track(life, Promise.resolve(cleanup()).catch(failed)); }
		catch (error) { failed(error); }
	}
	private track(life: Lifecycle, task: Promise<void>) {
		const settled = task.catch(error => this.report(life, error));
		life.tasks.add(settled);
		void settled.then(() => { life.tasks.delete(settled); });
	}
	private addCleanup(life: Lifecycle, cleanup: PluginCleanup): () => void {
		if (!this.current(life)) {
			this.disposeCallback(life, cleanup);
			return () => {};
		}
		life.cleanups.add(cleanup);
		return () => {
			if (life.cleanups.delete(cleanup)) this.disposeCallback(life, cleanup);
		};
	}
	private stop(life: Lifecycle) {
		// Invalidate synchronously BEFORE abort dispatches plugin listeners.
		if (this.lives.get(life.id) === life) this.lives.delete(life.id);
		if (life.teardown) return life.teardown;
		life.controller.abort();
		life.views.clear(); life.settings = undefined;
		life.notifications.clear(); life.resyncs.clear();
		const cleanups = [...life.cleanups].reverse();
		life.cleanups.clear();
		for (const cleanup of cleanups) this.disposeCallback(life, cleanup);
		const teardown = (async () => {
			await life.activation;
			while (life.tasks.size) await Promise.all([...life.tasks]);
		})();
		life.teardown = teardown;
		this.teardowns.set(life.id, teardown);
		void teardown.then(() => {
			if (this.teardowns.get(life.id) === teardown) this.teardowns.delete(life.id);
		});
		return teardown;
	}
	private async json(url: string, init?: RequestInit): Promise<unknown> {
		const response = await this.host.fetch(url, init);
		const body = await response.json();
		if (!response.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${response.status})`);
		return body;
	}
	async reload(clearError = true) {
		if (this.disposed) return;
		const generation = ++this.requestGeneration;
		try {
			const body = await this.json("/api/plugins") as { plugins: PluginInfo[] };
			if (this.disposed || generation !== this.requestGeneration) return;
			this.reconcile(body.plugins);
			this.publish({ loading: false, ...(clearError ? { error: undefined } : {}) });
		} catch (error) {
			if (generation === this.requestGeneration) this.publish({ loading: false, error: message(error) });
		}
	}
	/** Also the test seam for server-truth lifecycle transitions. */
	reconcile(infos: PluginInfo[]) {
		if (this.disposed) return;
		this.infos = infos;
		for (const life of [...this.lives.values()]) {
			const info = infos.find(item => item.id === life.id);
			if (!info || info.status !== "active" || !info.manifest?.main || info.revision !== life.revision) this.stop(life);
		}
		for (const info of infos) {
			if (info.status !== "active" || !info.manifest?.main || this.lives.has(info.id)) continue;
			const life: Lifecycle = {
				id: info.id, revision: info.revision, controller: new AbortController(), cleanups: new Set(),
				activation: Promise.resolve(), tasks: new Set(), views: new Map(),
				notifications: new Set(), resyncs: new Set(), phase: "loading",
			};
			this.cleanupErrors.delete(info.id);
			this.lives.set(info.id, life);
			const previousTeardown = this.teardowns.get(info.id);
			// Store the task before executing ANY plugin code (even styles can throw).
			life.activation = Promise.resolve().then(async () => {
				await previousTeardown;
				if (!this.current(life)) return;
				await this.activate(info, life);
			});
		}
		this.publish();
	}
	private async activate(info: PluginInfo, life: Lifecycle) {
		const manifest = info.manifest!;
		const listen = <T>(set: Set<T>, listener: T) => {
			if (!this.current(life)) return () => {};
			set.add(listener);
			return () => { set.delete(listener); };
		};
		const thisManager = this;
		let ui: PluginUi | undefined;
		const context: PluginFrontendContext = {
			manifest, signal: life.controller.signal,
			cleanup: cleanup => { this.addCleanup(life, cleanup); },
			registerView: view => {
				if (!this.current(life)) return () => {};
				if (!view || typeof view.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(view.id)) {
					throw new Error("Plugin view id must be a route-safe string of 1–128 characters, starting with a letter or number");
				}
				if (typeof view.name !== "string" || !view.name.trim()) throw new Error("Plugin view name must be a nonempty string");
				if (typeof view.mount !== "function") throw new Error("Plugin view mount must be a function");
				if (life.views.has(view.id)) throw new Error(`Duplicate plugin view: ${view.id}`);
				life.views.set(view.id, view); this.publish();
				let registered = true;
				return () => {
					if (!registered) return;
					registered = false;
					if (life.views.get(view.id) === view) { life.views.delete(view.id); this.publish(); }
				};
			},
			registerSettings: mount => {
				if (!this.current(life)) return () => {};
				if (typeof mount !== "function") throw new Error("Plugin settings must be a mount function");
				if (life.settings) throw new Error("Plugin settings are already registered");
				life.settings = mount; this.publish();
				let registered = true;
				return () => {
					if (!registered) return;
					registered = false;
					if (life.settings === mount) { life.settings = undefined; this.publish(); }
				};
			},
			get ui() {
				if (!ui) {
					if (!thisManager.host.createUi) throw new Error("Plugin UI host is unavailable");
					ui = thisManager.host.createUi({ signal: life.controller.signal, pluginId: life.id, onError: error => thisManager.report(life, error) });
				}
				return ui;
			},
			call: async <T>(operation: string, input?: unknown) => {
				if (!this.current(life)) throw new Error("Plugin is no longer active");
				const body = await this.json(`/api/plugins/${encodeURIComponent(info.id)}/call`, {
					method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ operation, ...(input === undefined ? {} : { input }) }), signal: life.controller.signal,
				}) as { result: T };
				if (!this.current(life)) throw new Error("Plugin is no longer active");
				return body.result;
			},
			onNotification: listener => listen(life.notifications, listener),
			onResync: listener => listen(life.resyncs, listener),
			app: {
				pathname: () => this.host.pathname(),
				openHome: () => { if (this.current(life)) this.host.navigate("/"); },
				openView: id => { if (this.current(life)) this.host.navigate(pluginViewPath(info.id, id)); },
				openSettings: () => { if (this.current(life)) this.host.openSettings?.(info.id); },
			},
		};
		try {
			if (manifest.styles && this.host.style) {
				this.addCleanup(life, this.host.style(pluginAssetUrl(info, manifest.styles), () => this.report(life, new Error("Plugin stylesheet could not be loaded"))));
			}
			const frontend = await this.host.importModule(pluginAssetUrl(info, manifest.main!));
			if (!this.current(life)) return;
			if (typeof frontend.activate !== "function") throw new Error("Plugin frontend must export activate(context)");
			const cleanup = await frontend.activate(context);
			if (typeof cleanup === "function") this.addCleanup(life, cleanup);
			if (!this.current(life)) return;
			life.phase = "active"; this.publish();
		} catch (error) {
			if (!this.current(life)) return;
			// A failed activation is not retried on every SSE/refetch. Keep an
			// inert error generation until the package revision changes.
			this.stop(life);
			life.phase = "error"; life.error = message(error);
			this.lives.set(life.id, life); this.publish();
		}
	}
	private deliver<T>(life: Lifecycle, listeners: Set<(event: T) => void>, event: T) {
		for (const listener of [...listeners]) {
			if (!this.current(life)) break;
			try { void Promise.resolve(listener(event)).catch(error => this.report(life, error)); }
			catch (error) { this.report(life, error); }
		}
	}
	notify(event: PluginNotification) {
		const life = this.lives.get(event.pluginId);
		if (life) this.deliver(life, life.notifications, event);
	}
	resync() {
		void this.reload();
		for (const life of this.lives.values()) {
			for (const listener of [...life.resyncs]) {
				if (!this.current(life)) break;
				try { void Promise.resolve(listener()).catch(error => this.report(life, error)); }
				catch (error) { this.report(life, error); }
			}
		}
	}
	/** Each mount gets a private child. A late cleanup can never erase a new
	 * view's DOM, including when navigating away and immediately back. */
	mount(id: string, mount: PluginMount, container: HTMLElement, onError: (error: string) => void): () => void {
		const life = this.lives.get(id);
		if (!life || !this.current(life)) return () => {};
		let alive = true;
		const controller = new AbortController();
		let returned: PluginCleanup | undefined;
		const child = container.ownerDocument.createElement("div");
		child.className = "min-h-0 min-w-0 flex-1";
		container.appendChild(child);
		const off = this.addCleanup(life, () => {
			alive = false; controller.abort(); child.remove();
			if (returned) { const cleanup = returned; returned = undefined; this.disposeCallback(life, cleanup); }
		});
		// Deferring to a microtask makes StrictMode's probe an inert mount.
		this.track(life, Promise.resolve().then(async () => {
			if (!alive || !this.current(life)) return;
			try {
				const cleanup = await mount(child, controller.signal);
				if (typeof cleanup === "function") {
					if (!alive || !this.current(life)) this.disposeCallback(life, cleanup);
					else returned = cleanup;
				}
			} catch (error) {
				if (alive && this.current(life)) { onError(message(error)); this.report(life, error); off(); }
			}
		}));
		return off;
	}
	/** Invalidation is immediate; callers may also await cooperative teardown. */
	dispose(): Promise<void> {
		if (!this.disposed) {
			this.disposed = true; this.requestGeneration++;
			for (const life of [...this.lives.values()]) this.stop(life);
			this.listeners.clear();
		}
		return Promise.all([...this.teardowns.values()]).then(() => {});
	}
}
