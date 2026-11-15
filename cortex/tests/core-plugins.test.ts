import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { createPluginHost, type PluginHostDependencies } from "../src/server/plugin-host.ts";
import type { PluginBackendContext } from "../src/core/plugins.ts";

function fixture(t: TestContext) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-core-host-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const core = { directory: path.join(root, "app", "core-plugins"), dataDirectory: path.join(root, "data", "core-plugin-data"), ids: ["official", "missing"] };
	const notifications: unknown[] = [];
	const deps: PluginHostDependencies = { core, appVersion: "0.4.1", onNotification: n => notifications.push(n) };
	function pkg(id: string, backend = "exports.activate = ctx => { ctx.handle('context', () => ({ ...ctx, keys: Object.keys(ctx) })); ctx.handle('ping', () => ctx.events.emit('changed')); };") {
		const code = path.join(core.directory, id);
		fs.mkdirSync(code, { recursive: true });
		fs.writeFileSync(path.join(code, "manifest.json"), JSON.stringify({ apiVersion: 1, id, name: id, version: "1.0.0", minAppVersion: "0.4.1", backend: "backend.cjs", main: "main.js" }));
		fs.writeFileSync(path.join(code, "backend.cjs"), backend);
		fs.writeFileSync(path.join(code, "main.js"), "export function activate() {}");
		return code;
	}
	const host = createPluginHost(deps); t.after(() => host.dispose());
	return { root, core, deps, pkg, host, notifications };
}

test("built-in packages activate on start; a missing package reports an error without blocking the others", async t => {
	const f = fixture(t); f.pkg("official");
	await f.host.initialize();
	assert.deepEqual(f.host.list().map(p => [p.id, p.origin, p.enabled, p.status]), [["missing", "core", true, "error"], ["official", "core", true, "active"]]);
	assert.equal(fs.existsSync(path.join(f.root, "data", "plugins")), false, "no community plugin folder is created");
});

test("a backend gets only its data folder, operations and notifications: no agent, model, worker or graph capability", async t => {
	const f = fixture(t); const code = f.pkg("official");
	await f.host.initialize();
	const ctx = await f.host.call("official", "context") as PluginBackendContext & { keys: string[] };
	assert.deepEqual([...ctx.keys].sort(), ["cleanup", "dataDirectory", "directory", "events", "handle", "manifest", "signal"]);
	assert.equal(ctx.directory, code); assert.equal(ctx.dataDirectory, path.join(f.core.dataDirectory, "official"));
	await f.host.call("official", "ping");
	assert.deepEqual(f.notifications, [{ pluginId: "official", topic: "changed", data: undefined }]);
	await assert.rejects(f.host.call("official", "unknown"), /Unknown plugin operation/);
	await assert.rejects(f.host.call("missing", "context"), /unavailable/);
});

test("assets are pinned at start; private data and the backend are never served", async t => {
	const f = fixture(t); const code = f.pkg("official");
	const before = fs.readdirSync(code).map(name => [name, fs.readFileSync(path.join(code, name), "utf8")]);
	await f.host.initialize();
	const ctx = await f.host.call("official", "context") as PluginBackendContext;
	fs.writeFileSync(path.join(ctx.dataDirectory, "private.json"), "private");
	assert.throws(() => f.host.asset("official", ["data", "private.json"]));
	assert.throws(() => f.host.asset("official", ["backend.cjs"]));
	assert.match(Buffer.from(f.host.asset("official", ["main.js"]).bytes).toString(), /activate/);
	assert.deepEqual(fs.readdirSync(code).map(name => [name, fs.readFileSync(path.join(code, name), "utf8")]), before);
	fs.writeFileSync(path.join(code, "main.js"), "export const changed = true;");
	assert.doesNotMatch(Buffer.from(f.host.asset("official", ["main.js"]).bytes).toString(), /changed/, "a changed package needs a restart");
});

test("replacing the core root with a symlink revokes assets", async t => {
	const f = fixture(t); f.pkg("official"); const root = f.core.directory;
	await f.host.initialize();
	const moved = path.join(f.root, "moved-code"); fs.renameSync(root, moved); fs.symlinkSync(moved, root);
	assert.throws(() => f.host.asset("official", ["main.js"]), /unsafe plugin asset/);
});

test("core data and package symlinks fail closed without writing their targets", async t => {
	for (const kind of ["package", "data-root", "data-id"] as const) {
		const f = fixture(t); const code = f.pkg("official"); const outside = path.join(f.root, `outside-${kind}`); fs.mkdirSync(outside);
		if (kind === "package") { fs.rmSync(code, { recursive: true }); fs.symlinkSync(outside, code); }
		else if (kind === "data-root") { fs.mkdirSync(path.dirname(f.core.dataDirectory), { recursive: true }); fs.symlinkSync(outside, f.core.dataDirectory); }
		else { fs.mkdirSync(f.core.dataDirectory, { recursive: true }); fs.symlinkSync(outside, path.join(f.core.dataDirectory, "official")); }
		await f.host.initialize();
		assert.equal(f.host.list().find(p => p.id === "official")!.status, "error", kind);
		assert.deepEqual(fs.readdirSync(outside), [], kind);
	}
});
