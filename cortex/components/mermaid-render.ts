/**
 * The app's ONE mermaid renderer (the chrome-melt wave, 2026-09-19): both the
 * in-chat block (components/md-blocks.tsx) and the session-scoped focus
 * overlay (components/session-overlay.tsx) render charts through this module
 * — one config per rendered mode, one plugin instance, unique render ids. This
 * REPLACES streamdown's internal mermaid path entirely: its fullscreen portal
 * was hard-wired `fixed inset-0` (covering the window-drag bar, X landing in
 * drag territory) with no styling hook, which is what drove the custom
 * component in the first place.
 */

import { createMermaidPlugin } from "@streamdown/mermaid";
import type { MermaidConfig } from "mermaid";
type RenderedMode = "light" | "dark";

/** The chart's base font size (px) — mermaid sizes ALL text relative to
 *  this, so it's the number the display-width cap (md-blocks) divides by:
 *  a chart shown at its natural width renders text at exactly this size.
 *  Pinned explicitly so a mermaid default change can't silently shift the
 *  cap (owner rule, chrome-melt tweaks wave, 2026-09-19: chart text must
 *  never render larger than the session's own text). */
export const MERMAID_FONT_SIZE = 16;

// Diagrams follow the rendered mode (light-mode wave, 2026-10-29): mermaid's
// dark theme in dark, its default theme in light. Callers pass the
// provider's resolvedMode and re-render when it changes. (Moved from
// ai-elements/message.tsx when the renderer became app-owned; the old
// `mermaid` prop wiring is retired.)
export function mermaidConfig(mode: RenderedMode): MermaidConfig {
	return {
		fontFamily: "ui-sans-serif, system-ui, sans-serif",
		fontSize: MERMAID_FONT_SIZE,
		securityLevel: "strict",
		theme: mode === "dark" ? "dark" : "default",
	};
}

const plugin = createMermaidPlugin();

/** Render one chart source to an svg string. The id is unique per call —
 *  mermaid caches rendered ids, and a repeated id across charts/renders
 *  returns the stale svg (the bug streamdown's own id minting avoids). */
export async function renderMermaid(chart: string, mode: RenderedMode): Promise<string> {
	const id = `lh-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
	const { svg } = await plugin.getMermaid(mermaidConfig(mode)).render(id, chart);
	return svg;
}

/** A chart svg's natural size — mermaid always emits a viewBox; this is the
 *  extent at zoom 1 (1 svg unit = 1 px), like the plan diagram's natural
 *  size. Figure svgs (2026-10-07) may declare width/height instead — that
 *  pair is the fallback. The final fallback covers a degenerate svg with
 *  neither. Pure. */
export function chartSize(svg: string): { w: number; h: number } {
	const m = /<svg[^>]*\bviewBox="([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)"/.exec(svg);
	if (m) {
		const w = Number.parseFloat(m[3]!);
		const h = Number.parseFloat(m[4]!);
		if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { w, h };
	}
	const attr = (name: string): number | null => {
		const a = new RegExp(`<svg\\b[^>]*?\\b${name}\\s*=\\s*["'](\\d+(?:\\.\d+)?)(?:px)?["']`, "i").exec(svg);
		if (!a) return null;
		const n = Number.parseFloat(a[1]!);
		return Number.isFinite(n) && n > 0 ? n : null;
	};
	const w = attr("width");
	const h = attr("height");
	if (w !== null && h !== null) return { w, h };
	return { w: 600, h: 400 };
}
