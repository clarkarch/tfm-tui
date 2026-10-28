// source.sh's contract: it pins ONE branch, hands the real installer the ref
// to build, and is the one-liner the README advertises.
//
//   bash source.sh           →  builds `main`
//   TFM_BRANCH=other         →  builds `other`
//
// The default has to be a branch that EXISTS: a default pointing at a deleted
// branch turns the documented one-liner into a 404, and nobody notices until
// a user runs it. So the default and the README URL are pinned together here.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// a stand-in for install.sh: it records the ref it was asked to build
const fakeInstaller = (dir: string): string => {
  const path = join(dir, "install.sh");
  writeFileSync(path, '#!/usr/bin/env bash\nprintf %s "$TFM_SOURCE" > "$TFM_RECORD"\n');
  return path;
};

// run source.sh with a local installer (file:// is allowed on purpose — the
// script supports it for exactly this kind of test)
const run = (env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "tfm-source-"));
  try {
    const record = join(dir, "record");
    const installer = fakeInstaller(dir);
    const res = Bun.spawnSync({
      cmd: ["bash", join(ROOT, "source.sh")],
      cwd: ROOT,
      env: {
        ...process.env,
        TFM_INSTALLER_URL: `file://${installer}`,
        TFM_RECORD: record,
        // scrub the ambient environment: a developer's own TFM_* must not
        // decide what the default is
        TFM_BRANCH: "",
        TFM_SOURCE: "",
        TFM_INSTALLER_REF: "",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: res.exitCode,
      err: res.stderr.toString(),
      ref: existsSync(record) ? readFileSync(record, "utf8") : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// curl is the one thing source.sh needs; the CI image has it
const haveCurl = Bun.which("curl") !== null;

describe("source.sh", () => {
  test.skipIf(!haveCurl)("builds main when no branch is given", () => {
    const r = run();
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.ref).toBe("main");
  });

  test.skipIf(!haveCurl)("TFM_BRANCH picks the branch to build", () => {
    const r = run({ TFM_BRANCH: "some-topic-branch" });
    expect(r.code).toBe(0);
    expect(r.ref).toBe("some-topic-branch");
  });

  test.skipIf(!haveCurl)("TFM_SOURCE wins over the branch", () => {
    const r = run({ TFM_BRANCH: "some-topic-branch", TFM_SOURCE: "v1.2.0" });
    expect(r.code).toBe(0);
    expect(r.ref).toBe("v1.2.0");
  });

  test("the README advertises the branch source.sh defaults to", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const url = /raw\.githubusercontent\.com\/clarkarch\/tfm-tui\/([^/]+)\/source\.sh/.exec(readme);
    expect(url).not.toBeNull();
    // the default is main (the test above pins the script); the README has to
    // point at the same branch, or the documented one-liner builds something
    // else — or nothing at all
    expect(url?.[1]).toBe("main");
  });
});
