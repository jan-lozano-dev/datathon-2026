/**
 * Live app notifications for the built-in plugins. Consumers fetch
 * authoritative state after a notification and refetch on reconnect;
 * notifications are not a durable replay log.
 */

/** The event vocabulary: the built-in plugins' channel only. */
export interface ServerEvents {
	/** Plugin availability/lifecycle changed; refetch the plugin list. */
	"plugins-changed": Record<string, never>;
	/** Live-only, plugin-scoped notifications. Reconnect requires snapshot resync. */
	"plugin-message": { pluginId: string; topic: string; data?: unknown };
}

export type ServerEventType = keyof ServerEvents;

/** The vocabulary's runtime names — the client wires one listener per
 *  name (types are erased; this list is the single source of truth for
 *  what the SSE channel can carry). */
export const SERVER_EVENT_TYPES = [
	"plugins-changed",
	"plugin-message",
] as const satisfies readonly ServerEventType[];

/** One notification: distribute over the vocabulary so narrowing `type`
 * actually narrows its payload (including plugin-scoped messages). */
export type ServerEvent<K extends ServerEventType = ServerEventType> = {
	[T in K]: { type: T } & ServerEvents[T];
}[K];

export type ServerEventListener = (event: ServerEvent) => void;

interface LhEventsGlobal {
	__lhEventBus?: Set<ServerEventListener>;
}

/** The shared listener set — globalThis-backed so every Next module entry
 *  (and every layer) sees ONE bus. Ephemeral by design: a process restart
 *  drops the listeners with their connections; emitters never queue. */
function listeners(): Set<ServerEventListener> {
	const g = globalThis as typeof globalThis & LhEventsGlobal;
	return (g.__lhEventBus ??= new Set());
}

/** Listen. Returns the unsubscribe function — the SSE route's cancel and
 *  any test cleanup call it; a dropped listener leaks nothing. */
export function subscribe(listener: ServerEventListener): () => void {
	const set = listeners();
	set.add(listener);
	return () => set.delete(listener);
}

/** Notify every listener. Zero subscribers is a no-op (no window open —
 *  the emission was for the stores' own bookkeeping anyway). One
 *  listener throwing must never break the others or the emitter: each
 *  call is isolated, the failure logged, the loop continues. */
export function emit<K extends ServerEventType>(type: K, payload: ServerEvents[K]): void {
	// Snapshot: a listener that unsubscribes (or subscribes) mid-emit must
	// not mutate the set under iteration.
	for (const listener of [...listeners()]) {
		try {
			listener({ type, ...payload } as ServerEvent);
		} catch (err) {
			console.error(`[events] listener failed on ${type}:`, err);
		}
	}
}
