// --- Kitty DnD machine id (docs/dnd-protocol.rst "Machine id"): the hashed
// local identity that lets the terminal flag cross-machine drops (X=1). Wire
// form is `1:<hex-hmac-sha256>` over /etc/machine-id with the fixed protocol
// key; anything unreadable degrades to "" (local-only behavior, unchanged).
// Pure leaf — the only node: import is crypto; file reads arrive via seam. ---

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

export const MACHINE_ID_HMAC_KEY = "tty-dnd-protocol-machine-id";

// base id -> wire form ("1:<lowercase hex>"); unknown future versions must be
// treated as a different machine, so only version 1 is ever produced here
export const hashedMachineId = (baseId: string): string =>
  `1:${createHmac("sha256", MACHINE_ID_HMAC_KEY).update(baseId).digest("hex")}`;

// read defaults to /etc/machine-id (trailing whitespace removed per spec)
export const localMachineId = (read: () => string = (): string => readFileSync("/etc/machine-id", "utf8")): string => {
  try {
    const base = read().trim();
    return base ? hashedMachineId(base) : "";
  } catch {
    return "";
  }
};
