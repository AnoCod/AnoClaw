/**
 * Fun idle status messages shown in the frontend status card
 * during agent waiting states (API retry, tool execution, etc.).
 */

const IDLE_MESSAGES = [
  'Analyzing context...',
  'Planning next steps...',
  'Processing information...',
  'Evaluating options...',
  'Synthesizing results...',
  'Organizing thoughts...',
  'Reviewing progress...',
  'Checking dependencies...',
  'Validating approach...',
  'Considering alternatives...',
  'Refining strategy...',
  'Assembling response...',
];

let _lastIdx = -1;

export function pickFunMessage(): string {
  let idx: number;
  do {
    idx = Math.floor(Math.random() * IDLE_MESSAGES.length);
  } while (idx === _lastIdx && IDLE_MESSAGES.length > 1);
  _lastIdx = idx;
  return IDLE_MESSAGES[idx];
}
