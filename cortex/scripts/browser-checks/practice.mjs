// Browser check of the practice build through the Chrome DevTools Protocol.
// Needs a running server with the M3Kang demo bank and a Chromium browser:
//   LH_BROWSER=/path/to/chrome-or-msedge LH_BASE_URL=http://localhost:3100 node scripts/browser-checks/practice.mjs
// The browser runs headless with a dead proxy for everything except loopback,
// so any request to the Internet fails and is reported. Screenshots go to
// LH_SCREENSHOTS (default: the system temp folder).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const EDGE = process.env.LH_BROWSER ?? (() => { throw new Error("Set LH_BROWSER to a Chromium browser"); })();
const BASE = process.env.LH_BASE_URL ?? "http://localhost:3100";
const OUT = process.env.LH_SCREENSHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), "lh-browser-"));
const PORT = 9333;
const profile = path.join(OUT, "edge-profile");
fs.rmSync(profile, { recursive: true, force: true });

const edge = spawn(EDGE, [
	"--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
	"--proxy-server=http://127.0.0.1:9", "--no-first-run", "--disable-extensions",
	"--disable-background-networking", "--disable-component-update", "--window-size=1280,900", "about:blank",
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let version;
for (let i = 0; i < 50 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(200); } }
const page = version.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let id = 0; const pending = new Map(); const external = new Set(); const problems = [];
ws.addEventListener("message", ev => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
	else if (msg.method === "Network.requestWillBeSent") {
		const url = msg.params.request.url;
		if (!url.startsWith(BASE) && !/^(data:|blob:|about:)/.test(url)) external.add(url);
	} else if (msg.method === "Runtime.exceptionThrown") problems.push("exception: " + msg.params.exceptionDetails.text + " " + (msg.params.exceptionDetails.exception?.description ?? "").slice(0, 200));
	else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") problems.push("console.error: " + msg.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 300));
});
const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
await send("Network.enable"); await send("Runtime.enable"); await send("Page.enable");
const evaluate = async expr => {
	const r = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
	if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
	return r.result.value;
};
const waitFor = async (expr, label, timeout = 30000) => {
	const end = Date.now() + timeout;
	while (Date.now() < end) { try { if (await evaluate(`return !!(${expr});`)) return; } catch {} await sleep(200); }
	throw new Error("timeout waiting for " + label);
};
const go = async url => { await send("Page.navigate", { url }); await sleep(500); };
const shot = async name => { const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64")); };
const typeInto = async (selector, text) => { await evaluate(`const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.();`); await send("Input.insertText", { text }); };
const key = async k => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: { ArrowRight: 39, ArrowLeft: 37, " ": 32, "3": 51 }[k] }); };
const clickText = (text, scope = "document") => evaluate(`const b = [...${scope}.querySelectorAll('button,a,label')].find(x => (x.getAttribute('aria-label') || x.textContent).trim() === ${JSON.stringify(text)}); if (!b) throw new Error('no control ' + ${JSON.stringify(text)}); b.click(); return true;`);
const results = [];
const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };

try {
	// 1. Start a session
	await go(BASE + "/");
	// No start screen: the app opens straight on a problem for the one local profile
	await waitFor(`document.querySelector('#problem-heading')`, "problem");
	check("no start screen, no name field", await evaluate(`return !document.querySelector('input[autocomplete=off]')`));
	const first = await evaluate(`return { heading: document.querySelector('#problem-heading').textContent, options: document.querySelectorAll('fieldset label').length, submitDisabled: [...document.querySelectorAll('button')].find(b => b.textContent === 'Submit answer').disabled }`);
	check("problem shown with five options, submit disabled until a letter", first.options === 5 && first.submitDisabled, JSON.stringify(first));
	check("no level graph on the page", await evaluate(`return !document.querySelector('figure svg')`));
	const state = await evaluate(`return await (await fetch('/api/practice/session?student=local')).text()`);
	check("session payload has no label", !/"label"/.test(state));
	await shot("01-problem.png");

	// 2. Answer with confidence, see the result, continue
	await clickText("B", "document.querySelector('fieldset')").catch(async () => evaluate(`document.querySelectorAll('fieldset input[type=radio]')[1].click()`));
	await evaluate(`document.querySelectorAll('fieldset input[type=radio]')[1].click()`);
	await evaluate(`document.querySelector('[data-testid=confidence-slider]').focus()`);
	await key("ArrowRight"); await key("ArrowRight");
	const conf = await evaluate(`return document.querySelector('[data-testid=confidence-value]').textContent`);
	check("confidence slider moves by stops", conf === "90%", conf);
	const firstKey = await evaluate(`return JSON.parse(${JSON.stringify(state)}).problem.key`);
	await clickText("Submit answer");
	await waitFor(`[...document.querySelectorAll('[role=status]')].some(n => /Right:|Not this time:/.test(n.textContent))`, "result");
	const result = await evaluate(`return [...document.querySelectorAll('[role=status]')].map(n => n.textContent).find(t => /Right:|Not this time:/.test(t))`);
	check("result shows correctness and the stated confidence", /You were 90% sure/.test(result), result.slice(0, 90));
	await shot("02-result.png");
	await clickText("Next problem");
	await waitFor(`!document.body.innerText.includes('You were 90% sure')`, "next problem");
	const second = await evaluate(`return document.querySelector('#problem-heading').textContent`);
	check("next problem is a different one", second !== first.heading, `${first.heading} -> ${second}`);

	// 3. Resume after reload
	await go(BASE + "/");
	await waitFor(`document.querySelector('#problem-heading')`, "resumed problem");
	const resumed = await evaluate(`return document.querySelector('#problem-heading').textContent`);
	check("reload resumes the same problem", resumed === second, resumed);
	const progress = await evaluate(`return document.body.innerText.match(/\\d+\\/1 right/)?.[0] ?? ''`);
	check("progress kept after reload", progress !== "", progress);

	// 4. Double submit and stale submit from the page
	const dup = await evaluate(`
		const s = await (await fetch('/api/practice/session?student=local')).json();
		const body = JSON.stringify({ student: 'local', key: s.problem.key, letter: 'C', confidence: 50, submission_id: 'e2e-dup-0001' });
		const post = () => fetch('/api/practice/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then(r => r.json());
		const [a, b] = await Promise.all([post(), post()]);
		const stale = await fetch('/api/practice/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ student: 'local', key: s.problem.key, letter: 'C', confidence: 50, submission_id: 'e2e-dup-0002' }) });
		return { replayed: [a.replayed, b.replayed].sort(), answered: b.student.answered, sameNext: a.problem?.key === b.problem?.key, stale: stale.status };`);
	check("parallel double submit records one attempt and advances once", JSON.stringify(dup.replayed) === "[false,true]" && dup.answered === 2 && dup.sameNext, JSON.stringify(dup));
	check("stale submit is refused", dup.stale === 409);

	// 5. Images
	await go(BASE + "/");
	await waitFor(`document.querySelector('#problem-heading')`, "problem");
	const img = await evaluate(`
		const s = await (await fetch('/api/practice/session?student=local')).json();
		const r = await fetch('/api/practice/image/' + encodeURIComponent(s.problem.key));
		const missing = await fetch('/api/practice/image/' + encodeURIComponent('nope_1|eng'));
		return { status: r.status, type: r.headers.get('content-type'), missing: missing.status };`);
	check("problem image served locally; unknown image 404", img.status === 200 && img.type === "image/png" && img.missing === 404, JSON.stringify(img));

	// 6. Removed features answer 404
	const gone = await evaluate(`
		const out = {};
		for (const u of ['/api/chat', '/api/chats', '/api/graph', '/api/settings', '/api/keys', '/api/models', '/api/search', '/api/stt/token', '/api/jobs', '/api/activity', '/api/themes', '/api/subscriptions', '/api/claude-code', '/chat/new', '/settings']) out[u] = (await fetch(u)).status;
		return out;`);
	check("removed routes are gone", Object.values(gone).every(s => s === 404), JSON.stringify(gone));
	check("no community install or toggle", (await evaluate(`return (await fetch('/api/plugins', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{"action":"refresh"}' })).status`)) === 405);

	// 7. Flashcards: deck, hand-written card with math, review
	await go(BASE + "/plugins/flashcards/library");
	await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Create deck')`, "flashcards library");
	await clickText("Create deck");
	await waitFor(`document.querySelector('[role=dialog] input')`, "deck dialog");
	await typeInto("[role=dialog] input", "Kangaroo facts");
	await clickText("Create", "document.querySelector('[role=dialog]')");
	await waitFor(`document.body.innerText.includes('Kangaroo facts') && !document.querySelector('[role=dialog]')`, "deck created");
	await clickText("Create card");
	await waitFor(`document.querySelectorAll('[role=dialog] textarea').length === 2`, "card dialog");
	await typeInto("[role=dialog] input", "Squares");
	await evaluate(`document.querySelectorAll('[role=dialog] textarea')[0].focus()`); await send("Input.insertText", { text: "What is $3^2$?" });
	await evaluate(`document.querySelectorAll('[role=dialog] textarea')[1].focus()`); await send("Input.insertText", { text: "$$3^2 = 9$$" });
	await clickText("Save", "document.querySelector('[role=dialog]')");
	await waitFor(`!document.querySelector('[role=dialog]')`, "card saved");
	await clickText("Review");
	await waitFor(`document.querySelector('.katex')`, "review question with KaTeX");
	await shot("03-flashcards-review.png");
	await key(" ");
	await waitFor(`document.querySelectorAll('.katex').length >= 2`, "revealed answer with KaTeX");
	await key("3");
	await sleep(800);
	const fcState = await evaluate(`return (await (await fetch('/api/plugins/flashcards/call', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{"operation":"get-state"}' })).json()).result`);
	check("flashcard created and rated with FSRS", fcState.decks.length === 1 && fcState.propositions.length === 1 && fcState.propositions[0].schedule.reps === 1, `reps=${fcState.propositions[0]?.schedule?.reps}`);
	check("no generation state in flashcards", fcState.batch === null && !("chunkBudget" in fcState.settings));
	await go(BASE + "/plugins/flashcards/library");
	await waitFor(`document.querySelector('[aria-label="Flashcards settings"]')`, "settings button");
	await evaluate(`document.querySelector('[aria-label="Flashcards settings"]').click()`);
	await waitFor(`document.body.innerText.includes('Desired retention')`, "settings dialog");
	const settingsText = await evaluate(`return document.querySelector('[role=dialog]')?.innerText ?? ''`);
	check("flashcards settings show only review settings", /Desired retention/.test(settingsText) && !/model|chunk/i.test(settingsText));
	await shot("04-flashcards-settings.png");
} catch (error) {
	results.push("FAIL run: " + error.message);
	try { await shot("error.png"); } catch {}
} finally {
	check("no request left the machine", external.size === 0, [...external].slice(0, 5).join(", "));
	check("no page errors", problems.length === 0, problems.slice(0, 5).join(" | "));
	console.log(results.join("\n"));
	ws.close(); edge.kill();
	setTimeout(() => process.exit(0), 500);
}
