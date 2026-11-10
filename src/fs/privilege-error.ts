// --- The ONE privilege-error type. A privilege failure is a FACT, and the
// fact must travel WITH the error. The old shape spelled it two ways: an
// errno code on the raw fs error, and a "permission denied" TEXT inside a
// wrapper's message — so the detector had to GUESS from prose, and guessing
// failed both ways: a non-privilege error whose text mentioned "permission
// denied" asked the user for a root password, while a privileged failure
// worded the EPERM way ("operation not permitted") was missed entirely.
//
// The OS's errno stays the precise encoding for a RAW fs failure (the fs
// layer cannot change it); the sudo layer has no errno — only a child's
// stderr — so it classifies the output ONCE and throws this type. The type
// is a leaf: fsutil's `fsErrText` reads it, elevate throws it, and nothing
// imports back. ---

export class PrivilegeError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "PrivilegeError";
  }
}
