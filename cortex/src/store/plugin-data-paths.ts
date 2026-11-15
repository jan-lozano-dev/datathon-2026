import * as fs from "node:fs";
import * as path from "node:path";
import { PLUGIN_ID_PATTERN } from "../core/plugins.ts";

export interface CorePluginDataLocation { directory: string; ids: readonly string[] }

/** <core-plugin-data>/<id> for a built-in plugin: no symlinks, no escape from the root. */
export function safePluginDataDirectory(id: string, core: CorePluginDataLocation, create = false): string | null {
	if (!PLUGIN_ID_PATTERN.test(id)) throw new Error("Invalid plugin id");
	if (!core.ids.includes(id)) throw new Error(`Not a built-in plugin: ${id}`);
	const root = path.resolve(/* turbopackIgnore: true */ core.directory);
	const plugin = path.join(/* turbopackIgnore: true */ root, id);
	let realRoot: string | undefined;
	for (const directory of [root, plugin]) {
		let stat: fs.Stats;
		try { stat = fs.lstatSync(directory); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (!create) return null;
			fs.mkdirSync(directory, { recursive: directory === root }); stat = fs.lstatSync(directory);
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe plugin data directory: ${directory}`);
		const real = fs.realpathSync(/* turbopackIgnore: true */ directory); realRoot ??= real;
		const relative = path.relative(realRoot, real);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Plugin data directory escapes root");
	}
	return plugin;
}
