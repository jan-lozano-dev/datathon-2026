// Formulas in a problem and a missing required figure. Needs a server whose
// bank holds a LaTeX problem first at level 4 and figure problems without
// images (see DEMO_SCOPE.md, "Verification").
//   LH_BROWSER=... LH_BASE_URL=http://localhost:3101 node scripts/browser-checks/missing-image.mjs
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const EDGE = process.env.LH_BROWSER ?? (() => { throw new Error("Set LH_BROWSER to a Chromium browser"); })();
const BASE = process.env.LH_BASE_URL ?? "http://localhost:3100";
const OUT = process.env.LH_SCREENSHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), "lh-browser-"));
const PORT = 9334;
const profile = path.join(OUT, "edge-profile-2");
fs.rmSync(profile, { recursive: true, force: true });
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--proxy-server=http://127.0.0.1:9",
	"--no-first-run", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list; for (let i = 0; i < 50 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(200); } }
const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map(); const external = new Set(); const problems = [];
ws.addEventListener("message", ev => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
	else if (msg.method === "Network.requestWillBeSent") { const url = msg.params.request.url; if (!url.startsWith(BASE) && !/^(data:|blob:|about:)/.test(url)) external.add(url); }
	else if (msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails.text);
	else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") problems.push(msg.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 200));
});
const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
await send("Network.enable"); await send("Runtime.enable"); await send("Page.enable");
const evaluate = async expr => { const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
const waitFor = async (expr, label, timeout = 30000) => { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await evaluate(`return !!(${expr});`)) return; } catch {} await sleep(200); } throw new Error("timeout waiting for " + label); };
const shot = async name => { const { data } = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64")); };
const results = []; const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
const clickText = text => evaluate(`const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('no ' + ${JSON.stringify(text)}); b.click(); return true;`);

try {
	await send("Page.navigate", { url: BASE + "/" });
	await waitFor(`document.querySelector('#problem-heading')`, "problem");
	const math = await evaluate(`return { heading: document.querySelector('#problem-heading').textContent, katex: document.querySelectorAll('article .katex').length, raw: document.querySelector('article').textContent.includes('\\\\frac') }`);
	check("problem text and options render formulas with KaTeX", math.katex >= 6, JSON.stringify(math));
	await shot("05-formulas.png");
	// Answer wrong until a figure problem whose image is missing comes up
	let found = false, answered = 0;
	for (let i = 0; i < 25 && !found; i++) {
		const s = await evaluate(`return await (await fetch('/api/practice/session?student=local')).json()`);
		if (!s.problem) break;
		if (s.problem.image_missing) { found = true; break; }
		await evaluate(`await fetch('/api/practice/answer', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ student: 'local', key: ${JSON.stringify(s.problem.key)}, letter: 'A', confidence: 50, submission_id: 'fx-' + Date.now() + '-' + Math.random().toString(16).slice(2) }) })`);
		answered++;
	}
	check("a figure problem without its image comes up", found, `after ${answered} answers`);
	await send("Page.navigate", { url: BASE + "/" });
	await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Skip (image missing)')`, "skip button");
	const before = await evaluate(`return await (await fetch('/api/practice/session?student=local')).json()`);
	const notice = await evaluate(`return document.querySelector('[role=alert]')?.textContent ?? ''`);
	check("missing figure is announced", /not available on this computer/.test(notice), notice.slice(0, 80));
	await shot("06-missing-image.png");
	await clickText("Skip (image missing)");
	await waitFor(`document.body.textContent.includes('did not count')`, "skip notice");
	const after = await evaluate(`return await (await fetch('/api/practice/session?student=local')).json()`);
	check("skip moves on without an attempt or level change", after.student.skipped === 1 && after.student.answered === before.student.answered && after.student.level_est === before.student.level_est && after.problem?.key !== before.problem.key,
		`skipped=${after.student.skipped} answered=${after.student.answered}`);
	const refuse = await evaluate(`const k = (await (await fetch('/api/practice/session?student=local')).json()).problem.key; return (await fetch('/api/practice/skip', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ student: 'local', key: k, submission_id: 'fx-skip-refused-1' }) })).status`);
	check("a problem whose image exists (or text-only) cannot be skipped", refuse === 409 || after.problem?.image_missing, `status ${refuse}`);
} catch (error) {
	results.push("FAIL run: " + error.message); try { await shot("error-2.png"); } catch {}
} finally {
	check("no request left the machine", external.size === 0, [...external].slice(0, 5).join(", "));
	check("no page errors", problems.length === 0, problems.slice(0, 5).join(" | "));
	console.log(results.join("\n")); ws.close(); edge.kill(); setTimeout(() => process.exit(0), 500);
}
