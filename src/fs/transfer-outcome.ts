// The per-item outcome of a copy/move.
//
// WHY this is its own leaf: the copy/move loop used to track the state of
// each item with THREE parallel variables:
//
//   let copiedHere = false;
//   let copyId: FileId | null = null;
//   let sourceRemovalFailed = false;
//
// Three booleans-with-payloads form a PRODUCT state space, and the product
// contains a state that is total data loss: "the copy landed" + "the source
// removal failed" + "the target may still be deleted". After a partial
// `rm(src)` the target holds the ONLY complete copy — deleting it destroys
// everything the user had.
//
// One tagged value, one owner, one meaning per variant:
//   - "none"                  — nothing landed; nothing to clean up.
//   - "landed"                — the copy landed; the half-copy cleanup MAY
//                               remove the target (a failed op must not
//                               leave a half-written copy behind).
//   - "sourceRemovalFailed"   — the copy landed, but the SOURCE could not be
//                               removed. The target is now the only complete
//                               data: the cleanup MUST NOT touch it, and a
//                               privileged retry may remove ONLY the source.
//
// `id` is the landed inode's identity. It is orthogonal to the phase (a
// copy can land without the engine reporting an identity), so it rides
// along as data rather than as another state variable.

import type { FileId } from "./fsutil";

export type TransferOutcome =
  | { kind: "none" }
  | { kind: "landed"; id: FileId | null }
  | { kind: "sourceRemovalFailed"; id: FileId | null };

export const noOutcome = (): TransferOutcome => ({ kind: "none" });

/** the copy landed at the target */
export const outcomeLanded = (id: FileId | null): TransferOutcome => ({ kind: "landed", id });

/** the copy landed, but removing the SOURCE failed — keep the target */
export const outcomeSourceRemovalFailed = (id: FileId | null): TransferOutcome => ({
  kind: "sourceRemovalFailed",
  id,
});

/** may the half-copy cleanup remove the target? */
export const mayRemoveTarget = (o: TransferOutcome): boolean => o.kind === "landed";

/** does a privileged retry need to remove ONLY the source? */
export const needsRemovalOnly = (o: TransferOutcome): boolean => o.kind === "sourceRemovalFailed";

/** the landed inode's identity, if one was reported */
export const outcomeId = (o: TransferOutcome): FileId | null => (o.kind === "none" ? null : o.id);
