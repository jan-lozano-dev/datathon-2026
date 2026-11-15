/**
 * THE EVENT BUS + NOTIFICATION CHANNEL (push-architecture slice 1,
 * 2026-10-02): the bus is pure core law (typed, globalThis-shared, error-
 * isolated); the SSE seam is one connection per open window — frames in,
 * cancel out, bus untouched. These pins are the channel's contract: every
 * future consumer (chat view, sidebar, dock) builds on exactly this.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emit, subscribe, type ServerEvent } from "../src/core/events.ts";
import { eventsResponse } from "../src/server/events-stream.ts";

// ─── the bus ────────────────────────────────────────────────────────────────

describe("event bus", () => {
	it("delivers typed events with their payload to every subscriber", () => {
		const got: ServerEvent[] = [];
		const off = subscribe((e) => got.push(e));
		emit("plugin-message", { pluginId: "flashcards", topic: "changed" });
		emit("plugins-changed", {});
		off();
		assert.deepEqual(got, [
			{ type: "plugin-message", pluginId: "flashcards", topic: "changed" },
			{ type: "plugins-changed" },
		]);
	});

	it("unsubscribe stops delivery, exactly once", () => {
		let calls = 0;
		const off = subscribe(() => calls++);
		emit("plugins-changed", {});
		off();
		emit("plugins-changed", {});
		assert.equal(calls, 1);
	});

	it("one listener throwing NEVER breaks the others (error isolation)", () => {
		const got: string[] = [];
		subscribe(() => {
			throw new Error("listener bug");
		});
		const off = subscribe((e) => got.push(e.type));
		emit("plugin-message", { pluginId: "chat_b", topic: "changed" });
		off();
		assert.deepEqual(got, ["plugin-message"]);
	});

	it("emit with zero subscribers is a silent no-op", () => {
		assert.doesNotThrow(() => emit("plugins-changed", {}));
	});

	it("the registry is globalThis-backed — the Next multi-entry law (turn-liveness discipline)", () => {
		// Every module instance must share ONE bus or nothing propagates
		// (the original incident: page render vs route each held a private
		// singleton). The key IS the contract.
		const g = globalThis as { __lhEventBus?: unknown };
		assert.ok(g.__lhEventBus instanceof Set, "the bus lives on globalThis");
	});

	it("an unsubscribe DURING emit is safe (snapshot iteration)", () => {
		const got: string[] = [];
		let off2: () => void = () => {};
		const off1 = subscribe(() => off2()); // listener 2 leaves mid-emit
		off2 = subscribe((e) => got.push(e.type));
		emit("plugins-changed", {});
		off1();
		off2();
		assert.deepEqual(got, ["plugins-changed"], "listener 2 still got THIS event (snapshot), no crash");
	});
});

// ─── the SSE seam ───────────────────────────────────────────────────────────

function decode(chunk: Uint8Array): string {
	return new TextDecoder().decode(chunk);
}

describe("eventsResponse (the SSE seam)", () => {
	it("holds an SSE response: event frames as they are emitted", async () => {
		const res = eventsResponse();
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("Content-Type"), "text/event-stream");
		assert.equal(res.headers.get("Cache-Control"), "no-cache, no-transform");
		assert.equal(res.headers.get("X-Accel-Buffering"), "no");
		const reader = res.body!.getReader();
		// The listener attached synchronously in start() — emit NOW lands
		// as a queued chunk (no race, single-threaded).
		emit("plugin-message", { pluginId: "chat_x", topic: "changed" });
		const { value, done } = await reader.read();
		assert.equal(done, false);
		assert.equal(
			decode(value!),
			'event: plugin-message\ndata: {"pluginId":"chat_x","topic":"changed"}\n\n',
			"one parseable SSE frame: type on the event line, payload on the data line",
		);
		await reader.cancel();
	});

	it("cancel() unsubscribes — later emits reach OTHER windows only", async () => {
		const first = eventsResponse();
		const second = eventsResponse();
		const r1 = first.body!.getReader();
		const r2 = second.body!.getReader();
		await r1.cancel(); // window one goes away
		emit("plugin-message", { pluginId: "chat_y", topic: "changed" });
		// window two still receives…
		const { value } = await r2.read();
		assert.match(decode(value!), /event: plugin-message/);
		// …and window one's stream is finished — no frame, just done.
		const after = await r1.read();
		assert.equal(after.done, true, "the cancelled connection carries nothing further");
		await r2.cancel();
	});

	it("the connection ends WITHOUT a [DONE] sentinel — the client owns the lifetime", async () => {
		// A turn's stream terminates itself; the notification channel never
		// self-closes. Pin the difference: settled events do NOT close the
		// stream — it stays live for the next event.
		const res = eventsResponse();
		const reader = res.body!.getReader();
		emit("plugin-message", { pluginId: "chat_z", topic: "changed" });
		await reader.read();
		emit("plugins-changed", {});
		const { value, done } = await reader.read();
		assert.equal(done, false, "the channel survives every event");
		assert.match(decode(value!), /event: plugins-changed/);
		await reader.cancel();
	});
});
