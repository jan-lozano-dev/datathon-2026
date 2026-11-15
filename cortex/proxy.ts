import { NextResponse, type NextRequest } from "next/server";
import { apiRequestRefusal } from "./src/server/api-access.ts";

/** Protects every API method: a Host check against DNS rebinding and a
 * cross-site check on writes. */
export function proxy(request: NextRequest) {
	const refusal = apiRequestRefusal(request);
	if (refusal) {
		return NextResponse.json(
			{ error: refusal },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = {
	// Must remain static literals.
	matcher: ["/api", "/api/:path*"],
};
