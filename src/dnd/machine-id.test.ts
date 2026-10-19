import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { hashedMachineId, localMachineId } from "./machine-id";

describe("hashedMachineId", () => {
  test("matches the openssl reference vector", () => {
    // printf '%s' "<base>" | openssl dgst -sha256 -hmac "tty-dnd-protocol-machine-id"
    const base = "test-machine-id";
    const expected = `1:${createHmac("sha256", "tty-dnd-protocol-machine-id").update(base).digest("hex")}`;
    expect(hashedMachineId(base)).toBe(expected);
    expect(hashedMachineId(base)).toMatch(/^1:[0-9a-f]{64}$/);
  });
});

describe("localMachineId", () => {
  test("hashes the trimmed machine-id file", () => {
    expect(localMachineId(() => "abc123\n")).toBe(hashedMachineId("abc123"));
  });

  test("missing/unreadable file degrades to empty (local-only behavior)", () => {
    expect(
      localMachineId(() => {
        throw new Error("ENOENT");
      }),
    ).toBe("");
  });
});
