import { pluginTransport } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The app's built-in plugins (only Flashcards). There is no install, rescan or toggle. */
export function GET() { return pluginTransport.list(); }
