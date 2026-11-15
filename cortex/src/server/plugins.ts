import * as path from "node:path";
import { PATHS } from "../../config.ts";
import packageJson from "../../package.json";
import { emit } from "../core/events.ts";
import corePluginIds from "../../core-plugins.json";
import { createPluginHost } from "./plugin-host.ts";
import { createPluginTransport } from "./plugin-transport.ts";

// Explicitly staged by build-server, not discovered by Next's filesystem tracer.
const core = {
	directory: path.join(/* turbopackIgnore: true */ PATHS.root, "core-plugins"),
	dataDirectory: path.join(/* turbopackIgnore: true */ PATHS.data, "core-plugin-data"),
	ids: corePluginIds,
};
type Host = ReturnType<typeof createPluginHost>;
interface Runtime { host: Host; ready: Promise<void> }
interface PluginGlobal { __lhPlugins?: Runtime }

/** Single composition for every Next entry. Importing this module does not load
 * plugin code or touch plugin storage; instrumentation (or a route) initializes it. */
function runtime(): Runtime {
	const global = globalThis as typeof globalThis & PluginGlobal;
	if (global.__lhPlugins) return global.__lhPlugins;
	const host = createPluginHost({
		core, appVersion: packageJson.version,
		onChange: () => emit("plugins-changed", {}),
		onNotification: (notification) => emit("plugin-message", notification),
	});
	const ready = Promise.resolve().then(() => host.initialize());
	global.__lhPlugins = { host, ready };
	return global.__lhPlugins;
}

export async function initializePlugins(): Promise<void> { await runtime().ready; }
export async function getPluginHost(): Promise<Host> {
	const { host, ready } = runtime();
	await ready;
	return host;
}
export const pluginTransport = createPluginTransport({ getHost: getPluginHost });
