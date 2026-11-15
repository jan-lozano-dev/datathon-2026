import { practiceResponse, readJsonObject } from "@/src/server";

/** Grade one letter A–E with its confidence; idempotent per submission_id. */
export async function POST(request: Request) {
	const body = await readJsonObject(request);
	if (!body) return Response.json({ error: { code: "bad_request", message: "Expected a JSON object." } }, { status: 400 });
	return practiceResponse({
		op: "answer",
		student: body.student,
		key: body.key,
		letter: body.letter,
		confidence: body.confidence,
		submission_id: body.submission_id,
	});
}
