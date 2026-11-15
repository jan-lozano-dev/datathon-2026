import { readFile } from "node:fs/promises";
import { practiceImagePath } from "@/src/server";

/** A problem's image from the local images folder (id|language → <id>_<language>.png). */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;
	let decoded: string;
	try { decoded = decodeURIComponent(key); } catch { decoded = ""; }
	const file = practiceImagePath(decoded);
	if (!file) return Response.json({ error: { code: "not_found", message: "Image not found." } }, { status: 404 });
	const bytes = await readFile(file);
	return new Response(new Uint8Array(bytes), {
		headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" },
	});
}
