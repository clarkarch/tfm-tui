// --- tmp+rename write: a crash or EDQUOT mid-write never leaves a truncated
// file at the target path. Used for caches keyed by content version — a
// partial write there would be served as a valid hit forever.
//
// This is a generic filesystem PRIMITIVE, not an fs-domain concern: config/,
// app/ and ui/ all need it, and config/ importing fs/fsutil.ts for it was a
// layering violation (config/ may depend on config/ + lib/ only). Hence the
// leaf.

import { writeFile, rename as fsRename, rm } from "node:fs/promises";

export const atomicWriteFile = async (p: string, data: Uint8Array | string): Promise<void> => {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  try {
    await fsRename(tmp, p);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
};
