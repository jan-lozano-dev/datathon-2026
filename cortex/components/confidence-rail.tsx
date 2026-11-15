import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { CONFIDENCE_STOPS } from "@/src/core";

/**
 * The confidence RAIL — the slider's paint, shared by two surfaces so they
 * can never drift apart (owner, 2026-10-01):
 *
 *   - the dock's live slider (question-dock) — a transparent range input
 *     rides on top of this paint, disc and all;
 *   - the ANSWERED card (owner round 6) — the same rail with NO disc,
 *     which itself communicates "this is a record, not a control".
 *
 * Geometry law: the rail spans the thumb-CENTER range (inset half a 16px
 * disc per side) so the dock's 0/100 stops sit flush at the very ends.
 * The static card has no thumb, but keeps the identical shape.
 *
 * Stack law: the page background as the base, SOLID stop ticks
 * as background layers UNDER the fill, and the fill itself TRANSPARENT
 * past the value — so ticks show only on the empty side, never over the
 * color. Ticks skip 0 and 100 (the rail's ends already say those).
 */

/** The six-step ramp (owner ruling): 0 red → 100 emerald, indexed by stop. */
export const CONFIDENCE_COLORS: readonly string[] = [
	"#ef4444", // 0
	"#f97316", // 30
	"#eab308", // 50
	"#84cc16", // 70
	"#22c55e", // 90
	"#10b981", // 100
];

/** The stop ticks: the foreground ink at 35% (the old fixed
 *  rgba(230,230,230,.35) was the dark foreground's value). */
const RAIL_TICK = "color-mix(in oklab, var(--foreground) 35%, transparent)";

/** The rail's paint for a stop value (0–100). */
export function confidenceRailStyle(value: number): CSSProperties {
	const color = CONFIDENCE_COLORS[CONFIDENCE_STOPS.indexOf(value)] ?? CONFIDENCE_COLORS[2]!;
	return {
		backgroundColor: "var(--background)",
		backgroundImage: [
			`linear-gradient(90deg, ${color} 0%, ${color} ${value}%, transparent ${value}%, transparent 100%)`,
			...[30, 50, 70, 90].map(() => `linear-gradient(90deg, ${RAIL_TICK}, ${RAIL_TICK})`),
		].join(", "),
		backgroundSize: ["100% 100%", "1px 100%", "1px 100%", "1px 100%", "1px 100%"].join(", "),
		backgroundPosition: ["0 0", ...[30, 50, 70, 90].map((p) => `${p}% 0`)].join(", "),
		backgroundRepeat: "no-repeat",
	};
}

/** The static rail — the slider's look, disc removed. */
export function ConfidenceRail({ value, className }: { value: number; className?: string }) {
	return (
		<div
			aria-hidden
			data-testid="confidence-rail"
			className={cn("h-1.5 w-full rounded-full border border-border", className)}
			style={confidenceRailStyle(value)}
		/>
	);
}

/** The nearest stop index for a raw slider position (0–100). */
export function nearestConfidenceIndex(value: number): number {
	let best = 0;
	for (let i = 1; i < CONFIDENCE_STOPS.length; i++) {
		if (Math.abs(CONFIDENCE_STOPS[i]! - value) < Math.abs(CONFIDENCE_STOPS[best]! - value)) best = i;
	}
	return best;
}

/**
 * The live confidence slider, compact: the question dock's snapped range
 * input over the painted rail (same stops, ramp colors and geometry — the
 * rail spans the thumb-center range, inset half the 16px disc per side, so
 * 0 and 100 rest flush at its ends). ←/→ move one stop.
 */
export function ConfidenceSlider({
	index,
	onChange,
	disabled,
	label = "Confidence",
}: {
	index: number;
	onChange: (index: number) => void;
	disabled?: boolean;
	label?: string;
}) {
	const value = CONFIDENCE_STOPS[index] ?? CONFIDENCE_STOPS[2]!;
	return (
		<div className={cn("flex items-center gap-3", disabled && "opacity-60")}>
			<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
			<div className="relative h-4 min-w-0 flex-1" data-testid="confidence-track">
				<div
					aria-hidden
					data-testid="confidence-rail"
					className="pointer-events-none absolute top-1/2 left-2 right-2 h-1.5 -translate-y-1/2 rounded-full border border-border"
					style={confidenceRailStyle(value)}
				/>
				<input
					type="range"
					min={0}
					max={100}
					step={1}
					value={value}
					disabled={disabled}
					aria-label="Confidence — the probability your selected answer is correct"
					aria-valuetext={`${value} percent`}
					title="The probability your selected answer is correct — 50% is a coin flip."
					data-testid="confidence-slider"
					onKeyDown={(e) => {
						if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
						e.preventDefault();
						const next = Math.max(0, Math.min(CONFIDENCE_STOPS.length - 1, index + (e.key === "ArrowRight" ? 1 : -1)));
						if (next !== index) onChange(next);
					}}
					onChange={(e) => onChange(nearestConfidenceIndex(Number(e.target.value)))}
					style={{ color: CONFIDENCE_COLORS[index] }}
					className={cn(
						"absolute inset-0 h-4 w-full cursor-pointer appearance-none bg-transparent outline-none disabled:cursor-default",
						"[&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent",
						"[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-current",
						"[&::-moz-range-track]:h-4 [&::-moz-range-track]:bg-transparent",
						"[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-current",
						"focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-ring",
					)}
				/>
			</div>
			<span data-testid="confidence-value" className="w-10 shrink-0 text-right font-mono text-sm tabular-nums">
				{value}%
			</span>
		</div>
	);
}
