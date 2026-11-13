// --- The Yes/No confirm REQUEST outcome: the ONE vocabulary for "the
// question is up" and "another question is already up".
//
// The dialog used to answer a bare boolean, so "busy" and "declined" were
// the same value: a second destructive request was indistinguishable from
// the user pressing No, and the callers that dropped the boolean (trash,
// update) swallowed the request in silence while the first dialog stayed up.
//
// Lives here (not ui/ui-dialogs) so the fs layer can name the collaborator's
// contract without importing up into ui/ — same layering rule as
// ./notify-level.
export type ConfirmOutcome = { kind: "opened" } | { kind: "busy" };

// The request is ONE object so a caller cannot transpose the title, body and
// affirmative verb by accident. `title` is the subject of the question and
// the fallback visible explanation; `body` is the visible explanation and
// should state the prompt's main point, while `yesLabel` is the action the
// affirmative option performs. A dismissal (esc / click-away) fires neither
// callback; `onNo` means the user actually answered No.
export type ConfirmRequest = {
  title: string;
  body?: string;
  yesLabel?: string;
  onYes: () => void;
  danger?: boolean;
  onNo?: () => void;
};
