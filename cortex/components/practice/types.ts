/** Shapes returned by /api/practice/* (practice/bridge.py). The label is never among them. */

export interface ProblemView {
	key: string;
	id: string;
	language: string;
	level: number;
	year?: number;
	text: string;
	/** Five text options, or {} when the options are only in the image. */
	options: Record<string, string>;
	text_only?: boolean;
	topic?: string;
	options_in_image: boolean;
	image_required: boolean;
	image: boolean;
	image_missing: boolean;
}

export interface StudentSummary {
	student_id: string;
	level: number;
	level_est: number;
	level_sd: number;
	answered: number;
	right: number;
	/** Problem level → [right, total]. */
	by_level: Record<string, [number, number]>;
	skipped: number;
	language: string;
	bank_size: number;
	bank_levels: number[];
}

export interface SessionState {
	student: StudentSummary | null;
	problem: ProblemView | null;
	done: boolean;
}

export type SubmissionResult =
	| { kind: "answer"; key: string; correct: boolean; letter: string; confidence: number; explanation: string | null }
	| { kind: "skip"; key: string };

export interface SubmissionReply extends SessionState {
	result: SubmissionResult;
	replayed: boolean;
}

export interface ProfileRow {
	student_id: string;
	language: string;
	answered: number;
	right: number;
	level: number;
	updated: number;
}

export interface ProfilesReply {
	profiles: ProfileRow[];
	/** Language code → playable problems. */
	languages: Record<string, number>;
}

export const LETTERS = ["A", "B", "C", "D", "E"] as const;
export type Letter = (typeof LETTERS)[number];

export const LANGUAGE_NAMES: Record<string, string> = { eng: "English", cat: "Català", spa: "Español" };
