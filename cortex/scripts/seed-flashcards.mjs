// Load a deck of hand-written cards into Flashcards through the running app.
//
//   node scripts/seed-flashcards.mjs                       # practice/decks/kangaroo-toolkit.json → http://localhost:3000
//   node scripts/seed-flashcards.mjs path/to/deck.json http://localhost:3100
//
// Safe to run again: the deck is found by name, and each card uses a fixed
// request id, so Flashcards' creation receipts never duplicate a card.
import * as fs from "node:fs";
import * as path from "node:path";

const file = process.argv[2] ?? path.join(import.meta.dirname, "..", "practice", "decks", "kangaroo-toolkit.json");
const base = (process.argv[3] ?? process.env.LH_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const { deck: deckName, cards } = JSON.parse(fs.readFileSync(file, "utf8"));

async function call(operation, input) {
	const response = await fetch(`${base}/api/plugins/flashcards/call`, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operation, ...(input === undefined ? {} : { input }) }),
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(`${operation}: ${body.error ?? response.status}`);
	return body.result;
}

let state = await call("get-state");
let deck = state.decks.find(d => d.name === deckName);
if (!deck) {
	state = await call("create-deck", { name: deckName });
	deck = state.decks.find(d => d.name === deckName);
}
const slug = deckName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
let added = 0, kept = 0;
for (const card of cards) {
	const before = state.propositions.length;
	try {
		const result = await call("create-card", {
			deckId: deck.id, name: card.name, question: card.question, answer: card.answer,
			requestId: `seed-${slug}-${card.id}`,
		});
		state = result.state;
	} catch (error) {
		// Seeded once into a deck that was later deleted: the receipt belongs to that deck.
		if (!/already used for different work/.test(error.message)) throw error;
	}
	if (state.propositions.length > before) added++; else kept++;
}
console.log(`${deckName}: ${added} cards added, ${kept} already there (${base})`);
