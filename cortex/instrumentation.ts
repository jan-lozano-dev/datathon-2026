/** Built-in plugins (Flashcards) start with the server. A plugin failure must
 * not prevent the practice test from working. */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { initializePlugins } = await import("./src/server/plugins.ts");
		try { await initializePlugins(); }
		catch (error) { console.error("[plugins] Initialization failed; the Flashcards view will report the error:", error); }
	}
}
