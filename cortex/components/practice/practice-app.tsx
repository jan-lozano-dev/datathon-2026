"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, ImageOffIcon, LoaderIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfidenceSlider } from "@/components/confidence-rail";
import { HostMarkdown } from "@/components/host-markdown";
import { cn } from "@/lib/utils";
import { CONFIDENCE_STOPS, DEFAULT_CONFIDENCE_INDEX } from "@/src/core";
import {
	LANGUAGE_NAMES,
	LETTERS,
	type Letter,
	type ProblemView,
	type ProfilesReply,
	type SessionState,
	type SubmissionReply,
} from "./types";

class ApiError extends Error {
	constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

async function api<T>(url: string, body?: unknown): Promise<T> {
	let response: Response;
	try {
		response = await fetch(url, body === undefined ? { cache: "no-store" } : {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch {
		throw new ApiError(0, "network", "The local server is not reachable. Is it still running?");
	}
	const data = (await response.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null;
	if (!response.ok || !data) {
		throw new ApiError(response.status, data?.error?.code ?? "internal", data?.error?.message ?? `Request failed (${response.status}).`);
	}
	return data;
}

const languageName = (code: string) => LANGUAGE_NAMES[code] ?? code;

/** The one local profile: there is no sign-in and no name to type. */
const STUDENT = "local";

/** The M3Kang practice: opens straight on the problem, resuming where it was left. */
export function PracticeApp() {
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const open = useCallback(() => {
		setError(null);
		api<ProfilesReply>("/api/practice")
			.then((reply) => {
				const codes = Object.keys(reply.languages);
				const language = codes.includes("eng") ? "eng" : codes[0];
				if (!language) throw new Error("The problem bank is empty.");
				return api<SessionState>("/api/practice/session", { student: STUDENT, language });
			})
			.then(() => setReady(true))
			.catch((e: Error) => setError(e.message));
	}, []);
	useEffect(open, [open]);

	if (error) return <div className="mx-auto max-w-xl p-6"><ErrorNote message={error} onRetry={open} /></div>;
	if (!ready) return <Loading label="Loading…" />;
	return <PracticeSession student={STUDENT} onMissing={open} />;
}

function Loading({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2 p-8 text-sm text-muted-foreground" role="status">
			<LoaderIcon className="size-4 animate-spin" /> {label}
		</div>
	);
}

function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
	return (
		<div role="alert" className="rounded-md border border-error/40 bg-error/10 p-3 text-sm">
			<p>{message}</p>
			{onRetry && <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>Try again</Button>}
		</div>
	);
}

// ─── start or resume ───────────────────────────────────────────────────────

// ─── one session ───────────────────────────────────────────────────────────

interface Shown {
	problem: ProblemView;
	submissionId: string;
}

/** getRandomValues works on plain-http LAN addresses too, where randomUUID does not. */
const newSubmissionId = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

function PracticeSession({ student, onMissing }: { student: string; onMissing: () => void }) {
	const [state, setState] = useState<SessionState | null>(null);
	const [shown, setShown] = useState<Shown | null>(null);
	const [outcome, setOutcome] = useState<SubmissionReply | null>(null);
	const [letter, setLetter] = useState<Letter | null>(null);
	const [confIdx, setConfIdx] = useState(DEFAULT_CONFIDENCE_INDEX);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const submitting = useRef(false);
	const [busy, setBusy] = useState(false);

	const show = useCallback((next: SessionState) => {
		setState(next);
		setOutcome(null);
		setLetter(null);
		setConfIdx(DEFAULT_CONFIDENCE_INDEX);
		setShown(next.problem ? { problem: next.problem, submissionId: newSubmissionId() } : null);
	}, []);

	const load = useCallback(() => {
		setError(null);
		api<SessionState>(`/api/practice/session?student=${encodeURIComponent(student)}`)
			.then((reply) => {
				if (!reply.student) { onMissing(); return; }
				show(reply);
			})
			.catch((e: Error) => setError(e.message));
	}, [student, onMissing, show]);
	useEffect(load, [load]);

	const submit = async (kind: "answer" | "skip") => {
		if (!shown || submitting.current || (kind === "answer" && !letter)) return;
		submitting.current = true;
		setBusy(true);
		setError(null);
		setNotice(null);
		const body = kind === "answer"
			? { student, key: shown.problem.key, letter, confidence: CONFIDENCE_STOPS[confIdx], submission_id: shown.submissionId }
			: { student, key: shown.problem.key, submission_id: shown.submissionId };
		try {
			const reply = await api<SubmissionReply>(`/api/practice/${kind}`, body);
			if (reply.result.kind === "skip") {
				setNotice("Skipped: this problem's image is missing. It did not count.");
				show(reply);
			} else {
				setState(reply);
				setOutcome(reply);
			}
		} catch (e) {
			const err = e as ApiError;
			if (err.status === 409) {
				// Answered elsewhere (another tab) or the bank changed: show what the server has now.
				setNotice("That problem was already handled. Here is the current one.");
				load();
			} else {
				// Nothing was recorded: the same submission id may be sent again safely.
				setError(err.message);
			}
		} finally {
			submitting.current = false;
			setBusy(false);
		}
	};

	if (error && !state) return <div className="mx-auto max-w-3xl p-6"><ErrorNote message={error} onRetry={load} /></div>;
	if (!state?.student) return <Loading label="Loading your session…" />;
	const summary = state.student;

	return (
		<div className="mx-auto max-w-3xl p-4 md:p-6">
			<main className="min-w-0 space-y-4">
				<ProgressBar student={summary} />
				{notice && <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm" role="status">{notice}</p>}
				{error && <ErrorNote message={error} />}
				{shown ? (
					<ProblemCard
						problem={shown.problem}
						letter={letter}
						onLetter={setLetter}
						locked={busy || outcome !== null}
					/>
				) : (
					<Finished student={summary} />
				)}
				{shown && outcome === null && (
					<div className="space-y-4 rounded-md border border-border p-4">
						<ConfidenceSlider index={confIdx} onChange={setConfIdx} disabled={busy} />
						<div className="flex flex-wrap items-center gap-2">
							<Button onClick={() => submit("answer")} disabled={!letter || busy}>
								{busy ? "Checking…" : "Submit answer"}
							</Button>
							{shown.problem.image_missing && (
								<Button variant="outline" onClick={() => submit("skip")} disabled={busy}>
									Skip (image missing)
								</Button>
							)}
							{!letter && <span className="text-xs text-muted-foreground">Choose one letter first.</span>}
						</div>
					</div>
				)}
				{outcome && outcome.result.kind === "answer" && (
					<ResultPanel
						correct={outcome.result.correct}
						letter={outcome.result.letter}
						confidence={outcome.result.confidence}
						explanation={outcome.result.explanation}
						hasNext={outcome.problem !== null}
						onNext={() => show(outcome)}
					/>
				)}
			</main>
		</div>
	);
}

function ProgressBar({ student }: { student: SessionState["student"] & object }) {
	const seen = student.answered + student.skipped;
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3 text-sm">
			<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
				<span className="text-muted-foreground">{languageName(student.language)}</span>
				<span>Level <strong className="tabular-nums">{student.level}</strong></span>
				<span className="tabular-nums">{student.right}/{student.answered} right</span>
				<span className="text-muted-foreground tabular-nums">{seen} of {student.bank_size} seen</span>
			</div>
		</div>
	);
}

function ProblemCard({
	problem,
	letter,
	onLetter,
	locked,
}: {
	problem: ProblemView;
	letter: Letter | null;
	onLetter: (letter: Letter) => void;
	locked: boolean;
}) {
	const imageUrl = `/api/practice/image/${encodeURIComponent(problem.key)}`;
	const [imageFailed, setImageFailed] = useState(false);
	return (
		<article className="space-y-4" aria-labelledby="problem-heading">
			<h2 id="problem-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Level {problem.level}{problem.year ? ` · ${problem.year}` : ""} · {problem.id}
			</h2>
			<div className="font-prose text-base leading-relaxed">
				<HostMarkdown text={problem.text} />
			</div>

			{problem.image && problem.image_required && !imageFailed && (
				// eslint-disable-next-line @next/next/no-img-element
				<img
					src={imageUrl}
					alt={`Figure for problem ${problem.id}`}
					className="max-h-[28rem] max-w-full rounded-md border border-border bg-white object-contain"
					onError={() => setImageFailed(true)}
				/>
			)}
			{problem.image && !problem.image_required && (
				<details className="text-sm">
					<summary className="cursor-pointer text-muted-foreground">Show the original page</summary>
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img src={imageUrl} alt={`Original page of problem ${problem.id}`} className="mt-2 max-w-full rounded-md border border-border bg-white" />
				</details>
			)}
			{(problem.image_missing || imageFailed) && (
				<p role="alert" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
					<ImageOffIcon className="mt-0.5 size-4 shrink-0" />
					{problem.image_missing
						? "This problem needs a figure that is not available on this computer. You can skip it; skipping does not count against you."
						: "The figure could not be loaded. Reload the page to try again."}
				</p>
			)}

			<fieldset className="space-y-2" disabled={locked}>
				<legend className="mb-2 text-sm text-muted-foreground">
					{problem.options_in_image ? "The options are shown in the figure. Choose one letter:" : "Choose one answer:"}
				</legend>
				<div className={cn(problem.options_in_image ? "flex flex-wrap gap-2" : "grid gap-2 sm:grid-cols-2")}>
					{LETTERS.map((x) => (
						<label
							key={x}
							className={cn(
								"flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors",
								letter === x ? "border-foreground bg-muted/60" : "border-border hover:bg-muted/40",
								locked && "cursor-default",
							)}
						>
							<input
								type="radio"
								name={`answer-${problem.key}`}
								value={x}
								checked={letter === x}
								onChange={() => onLetter(x)}
								className="sr-only"
							/>
							<span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs", letter === x ? "border-foreground" : "border-border")}>
								{x}
							</span>
							{!problem.options_in_image && (
								<span className="min-w-0 font-prose [&_p]:my-0"><HostMarkdown text={problem.options[x] ?? ""} /></span>
							)}
						</label>
					))}
				</div>
			</fieldset>
		</article>
	);
}

function ResultPanel({
	correct,
	letter,
	confidence,
	explanation,
	hasNext,
	onNext,
}: {
	correct: boolean;
	letter: string;
	confidence: number;
	explanation: string | null;
	hasNext: boolean;
	onNext: () => void;
}) {
	const next = useRef<HTMLButtonElement>(null);
	const [explained, setExplained] = useState(false);
	useEffect(() => next.current?.focus(), []);
	return (
		<div
			role="status"
			className={cn(
				"space-y-3 rounded-md border p-4",
				correct ? "border-success/50 bg-success/10" : "border-warning/50 bg-warning/10",
			)}
		>
			<p className="flex items-center gap-2 font-medium">
				{correct ? <CheckIcon className="size-5" /> : <XIcon className="size-5" />}
				{correct ? `Right: ${letter} is correct.` : `Not this time: ${letter} is not the answer.`}
			</p>
			<p className="text-sm text-muted-foreground">
				You were {confidence}% sure. {hasNext
					? correct ? "The next problem is a bit harder." : "The next problem is a bit easier."
					: ""}
			</p>
			{explained && explanation && (
				<div id="explanation" className="rounded-md border border-border bg-background/60 p-3 font-prose text-base leading-relaxed">
					<HostMarkdown text={explanation} />
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				{explanation && (
					<Button variant="outline" aria-expanded={explained} aria-controls="explanation" onClick={() => setExplained((open) => !open)}>
						{explained ? "Hide explanation" : "Explain"}
					</Button>
				)}
				<Button ref={next} onClick={onNext}>{hasNext ? "Next problem" : "See summary"}</Button>
			</div>
		</div>
	);
}

function Finished({ student }: { student: SessionState["student"] & object }) {
	return (
		<div className="space-y-2 rounded-md border border-border p-4" role="status">
			<p className="font-medium">You have seen every problem available in {languageName(student.language)}.</p>
			<p className="text-sm text-muted-foreground">
				{student.right} of {student.answered} right · estimated level {student.level_est.toFixed(1)}
				{student.skipped ? ` · ${student.skipped} skipped for a missing figure` : ""}
			</p>
		</div>
	);
}
