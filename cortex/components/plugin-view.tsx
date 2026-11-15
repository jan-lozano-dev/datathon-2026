"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { SettingsIcon } from "lucide-react";
import { SurfaceRegion, usePageSurfaceBoundary } from "./plugin-surfaces";
import { PluginMountPoint, usePlugins } from "@/components/plugins";
import { HostDialog } from "@/components/host-dialog";
import { Button } from "@/components/ui/button";

/** A built-in plugin's view (Flashcards), with its settings in a dialog. */
export function PluginViewScreen({ pluginId, viewId }: { pluginId: string; viewId: string }) {
	const { snapshot } = usePlugins();
	const pathname = usePathname();
	const bodyRef = useRef<HTMLDivElement>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const viewPath = `/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(viewId)}`;
	const surfaceTarget = usePageSurfaceBoundary({ active: pathname === viewPath, viewKey: viewPath, bodyRef });
	const plugin = snapshot.plugins.find(item => item.info.id === pluginId);
	const view = plugin?.views.find(item => item.id === viewId);
	const loading = snapshot.loading || plugin?.phase === "loading";
	const unavailable = !plugin ? "This feature is not available in this build." : "This view is not available.";
	return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
		<div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 pt-4 md:px-6">
			<h1 className="min-w-0 flex-1 truncate font-title text-3xl tracking-tight">{view?.name ?? plugin?.info.manifest?.name ?? "Plugin"}</h1>
			{plugin?.settings && (
				<Button variant="ghost" size="icon" aria-label={`${view?.name ?? "Plugin"} settings`} title="Settings" onClick={() => setSettingsOpen(true)}>
					<SettingsIcon className="size-4" />
				</Button>
			)}
		</div>
		<div ref={bodyRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
			<div data-plugin-view-scroll="" className="relative mx-auto flex min-h-0 w-full max-w-3xl min-w-0 flex-1 flex-col overflow-y-auto">
				{snapshot.error && <p role="alert" className="px-5 py-3 text-xs text-destructive">{snapshot.error}</p>}
				{plugin?.error && <p role="alert" className="px-5 py-3 text-xs text-destructive">{plugin.error}</p>}
				{loading ? <p role="status" className="px-5 py-4 text-xs text-muted-foreground">Loading…</p>
					: view ? <PluginMountPoint key={`${pluginId}/${viewId}/${plugin!.info.revision}`} pluginId={pluginId} mount={view.mount} label={view.name} />
						: <div className="px-5 py-4 text-sm text-muted-foreground"><p>{unavailable}</p><Link href="/" className="mt-3 inline-block underline">Back to practice</Link></div>}
			</div>
			<SurfaceRegion target={surfaceTarget} />
		</div>
		{plugin?.settings && (
			<HostDialog open={settingsOpen} onClose={() => { setSettingsOpen(false); return "closed"; }} aria-label={`${view?.name ?? "Plugin"} settings`}
				backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" }}
				frame={<div tabIndex={-1} className="relative mx-4 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border bg-card shadow-lg outline-none" />}>
				<div className="min-h-0 overflow-y-auto p-5">
					<h2 className="mb-3 text-sm font-medium">Settings</h2>
					<PluginMountPoint pluginId={pluginId} mount={plugin.settings} label="Settings" />
				</div>
				<Button variant="ghost" size="sm" className="absolute right-2 top-2" onClick={() => setSettingsOpen(false)}>Close</Button>
			</HostDialog>
		)}
	</div>;
}
