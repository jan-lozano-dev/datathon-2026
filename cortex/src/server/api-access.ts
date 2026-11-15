import { isIP } from "node:net";

/** The page's own origin as addressed by the browser, never a forwarded one. */
export function requestOrigin(request: Request): string | undefined {
	try {
		const url = new URL(request.url);
		const host = request.headers.get("host") ?? url.host;
		const addressed = new URL(`${url.protocol}//${host}`);
		if (!["http:", "https:"].includes(addressed.protocol) || addressed.username || addressed.password || addressed.pathname !== "/" || addressed.search || addressed.hash) return;
		return addressed.origin;
	} catch { return; }
}

/** DNS rebinding needs an attacker-owned DNS name, so localhost names and IP
 * literals are always safe. Any other name must be listed in LH_ALLOWED_HOSTS
 * (comma-separated, case-insensitive, port ignored). */
export function browserHostAllowed(host: string | null, env: Record<string, string | undefined> = process.env): boolean {
	if (!host) return false;
	let hostname: string;
	try {
		hostname = new URL(`http://${host}`).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
	if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) return true;
	const allowed = (env.LH_ALLOWED_HOSTS ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
	return allowed.includes(hostname);
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** API gate: a Host check against DNS rebinding and a cross-site check on
 * writes. Not user authentication: anyone who can reach the server can use it.
 * Writes without Origin or Sec-Fetch-Site come from non-browser clients and are
 * allowed. Returns the refusal, if any. */
export function apiRequestRefusal(request: Request, env: Record<string, string | undefined> = process.env): string | undefined {
	if (!browserHostAllowed(request.headers.get("host") ?? new URL(request.url).host, env)) {
		return "This host name is not allowed. Use localhost or an IP address, or add the name to LH_ALLOWED_HOSTS.";
	}
	if (READ_METHODS.has(request.method.toUpperCase())) return;
	const site = request.headers.get("sec-fetch-site");
	const origin = request.headers.get("origin");
	if ((site !== null && site !== "same-origin") || (origin !== null && origin !== requestOrigin(request))) {
		return "Cross-site requests to the API are not allowed.";
	}
}
