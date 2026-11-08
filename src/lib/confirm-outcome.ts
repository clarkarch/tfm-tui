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
