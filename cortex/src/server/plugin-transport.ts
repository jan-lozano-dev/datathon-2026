import { isPluginHostError } from "./plugin-host.ts";
import type { PluginInfo } from "../core/plugins.ts";

/** Thin HTTP adapter, separately injectable so its tests never boot plugins. */
export interface PluginTransportHost {
	list(): PluginInfo[];
	call(id: string, operation: string, input: unknown): Promise<unknown>;
	asset(id: string, segments: string[]): { bytes: Uint8Array; contentType: string };
}
class InputError extends Error {}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
async function objectBody(request: Request): Promise<Record<string, unknown>> {
	let body: unknown;
	try { body = await request.json(); } catch { throw new InputError("Expected a JSON object"); }
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Expected a JSON object");
	return body as Record<string, unknown>;
}
export function createPluginTransport(deps: { getHost(): Promise<PluginTransportHost> }) {
	const guarded = async (handle: () => Promise<Response>) => {
		try { return await handle(); }
		catch (error) {
			const status = error instanceof InputError ? 400 : isPluginHostError(error) ? error.status : 500;
			return json({ error: error instanceof Error || isPluginHostError(error) ? error.message : "Plugin request failed" }, status);
		}
	};
	return {
		list: () => guarded(async () => json({ plugins: (await deps.getHost()).list() })),
		call: (id: string, request: Request) => guarded(async () => {
			const body = await objectBody(request);
			if (typeof body.operation !== "string" || !body.operation.trim()) throw new InputError("operation must be a nonempty string");
			const host = await deps.getHost();
			return json({ result: (await host.call(id, body.operation, body.input)) ?? null });
		}),
		asset: (id: string, segments: string[]) => guarded(async () => {
			const { bytes, contentType } = (await deps.getHost()).asset(id, segments);
			return new Response(new Uint8Array(bytes), { headers: { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
		}),
	};
}
