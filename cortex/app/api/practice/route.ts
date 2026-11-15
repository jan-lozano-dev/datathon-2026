import { practiceResponse } from "@/src/server";

/** Local profiles that can be resumed, and the bank's languages. */
export async function GET() {
	return practiceResponse({ op: "profiles" });
}
