/** Source guard for the experimentally verified Turbopack privacy boundary.
 * Path producers can trace data even without reads, and a later join can
 * reintroduce assets despite an upstream opt-out. Actual deployment behavior
 * is checked by the production payload guard and source-free smoke.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import ts from "typescript";

function paths(relative: string) {
	const text = fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
	const file = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
			&& node.expression.expression.getText(file) === "path"
			&& ["join", "resolve"].includes(node.expression.name.text)) calls.push(node);
		ts.forEachChild(node, visit);
	};
	visit(file);
	const ignored = (call: ts.CallExpression) => /\/\*\s*turbopackIgnore:\s*true\s*\*\//.test(
		text.slice(call.expression.end, call.arguments[0]!.getStart(file)),
	);
	return { file, calls, ignored };
}

test("config opts out each mutable path producer", () => {
	const { file, calls, ignored } = paths("config.ts");
	assert.ok(calls.length > 0);
	for (const call of calls) assert.ok(ignored(call), `Runtime path must not ship: ${call.getText(file)}`);
});

test("plugin runtime paths never become deployment assets", () => {
	for (const [relative, count] of [["src/server/plugins.ts", 2], ["src/store/plugin-data-paths.ts", 2]] as const) {
		const { file, calls, ignored } = paths(relative);
		assert.equal(calls.length, count, relative);
		for (const call of calls) assert.ok(ignored(call), `Runtime path must not ship: ${call.getText(file)}`);
	}
});

test("practice paths to M3Kang data, the trainer and the database never become deployment assets", () => {
	const { file, calls, ignored } = paths("src/server/practice.ts");
	const shipped = calls.filter(call => call.getText(file) === 'path.join(ROOT, "practice", "bridge.py")');
	assert.equal(shipped.length, 1, "the bridge script is the one shipped asset");
	const runtime = calls.filter(call => !shipped.includes(call));
	assert.ok(runtime.length >= 6);
	for (const call of runtime) {
		const outer = call.parent && ts.isCallExpression(call.parent) ? call.parent : undefined;
		assert.ok(ignored(call) || (outer !== undefined && calls.includes(outer) && ignored(outer)), `Runtime path must not ship: ${call.getText(file)}`);
	}
});
