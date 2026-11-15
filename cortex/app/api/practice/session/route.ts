import { practiceResponse, readJsonObject } from "@/src/server";

/** Resume: the student's progress and the problem being shown (never its label). */
export async function GET(request: Request) {
	const student = new URL(request.url).searchParams.get("student") ?? "";
	return practiceResponse({ op: "state", student });
}

/** Start a session (or resume an existing one with the same name). */
export async function POST(request: Request) {
	const body = await readJsonObject(request);
	if (!body) return Response.json({ error: { code: "bad_request", message: "Expected a JSON object." } }, { status: 400 });
	return practiceResponse({ op: "start", student: body.student, language: body.language });
}
