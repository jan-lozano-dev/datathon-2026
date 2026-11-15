"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppNav } from "@/components/app-nav";
import { HostRouteLifetimeProvider } from "@/components/host-content-root";
import { InteractionLayersProvider } from "@/components/interaction-layers";
import { PluginWidgets } from "@/components/plugins";

/** The app frame: navigation, page content, and the host widgets plugins open. */
export function AppShell({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	return (
		<HostRouteLifetimeProvider pathname={pathname}>
			<InteractionLayersProvider>
				{/* Viewport-bounded frame: pages scroll inside the content area, so a
				    plugin view's body (and the review surfaces it opens) always has the
				    visible height, never the full height of its content. */}
				<div className="flex h-dvh flex-col">
					<AppNav />
					<div className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">{children}</div>
				</div>
				<PluginWidgets />
			</InteractionLayersProvider>
		</HostRouteLifetimeProvider>
	);
}
