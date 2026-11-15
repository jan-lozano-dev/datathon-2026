import { practiceResponse, readJsonObject } from "@/src/server";

/** Skip the shown problem when its required image is missing; records no attempt. */
export async function POST(request: Request) {
	const body = await readJsonObject(request);
	if (!body) return Response.json({ error: { code: "bad_request", message: "Expected a JSON object." } }, { status: 400 });
	return practiceResponse({ op: "skip", student: body.student, key: body.key, submission_id: body.submission_id });
}
