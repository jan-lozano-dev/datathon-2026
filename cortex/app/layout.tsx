import type { Metadata } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { ServerEventsProvider } from "@/components/server-events";
import { PluginsProvider } from "@/components/plugins";

// Chrome = JetBrains Mono, prose = Source Sans 3, titles = CMU Serif (the
// bundled lh-cmu @font-face in globals.css). next/font self-hosts the two
// Google fonts at build time: the running app makes no font requests.
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Cortex",
	description: "Offline Kangaroo maths practice with an adaptive trainer, explanations and flashcards.",
};

/** One fixed look: the Default theme's colors are the literals in globals.css. */
export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={`dark ${ui.variable} ${prose.variable}`}>
			<body className="min-h-dvh bg-background text-foreground antialiased">
				<ServerEventsProvider>
					<PluginsProvider>
						<AppShell>{children}</AppShell>
					</PluginsProvider>
				</ServerEventsProvider>
			</body>
		</html>
	);
}
