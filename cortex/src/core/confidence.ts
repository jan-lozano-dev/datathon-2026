/** The confidence slider's snap stops (owner, 2026-10-01): raw probability
 *  that the selected answer is correct, uneven on purpose — resolution
 *  concentrates at the top where the calibration signal lives (90 vs 100
 *  separates knows from mastered). 50 is a genuine coin flip and the
 *  resting default — untouched and deliberate 50 are the same number. */
export const CONFIDENCE_STOPS: readonly number[] = [0, 30, 50, 70, 90, 100];
export const DEFAULT_CONFIDENCE_INDEX = 2;
