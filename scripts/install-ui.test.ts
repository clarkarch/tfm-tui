// The installer's rendering contract, pinned headlessly.
//
// install.sh has to stay one self-contained file (it is run as `curl … | bash`),
// so there is nothing to import: `TFM_INSTALL_LIB_ONLY=1 source install.sh`
// defines the renderers and stops, and each case drives them in a fresh bash.
//
// What this protects, in the order the bugs happened:
//   1. width must be counted in DISPLAY COLUMNS, not bytes (`·` is two bytes in
//      the C locale, which shifted every panel border by one glyph),
//   2. a step's finished line must REPLACE its pending line (the old installer
//      printed "Downloaded tfm" while curl was still running),
//   3. a panel must wrap instead of truncating and must never exceed the
//      terminal width,
//   4. plain mode (pipes, CI, NO_COLOR, narrow terminals) must never draw a box,
//   5. install_binary tests the staged build BEFORE the swap, installs it under
//      both command names, and leaves no tfm.bak behind.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// FANCY/COLS come AFTER the source on purpose: install.sh derives them from the
// environment at load time (no tty here → FANCY=0), and the test decides.
const PRELUDE = `${String.raw`source ./install.sh
C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'
C_ERR=$'\033[31m'; C_BRAND=$'\033[36m'; C_RST=$'\033[0m'
DEST="$HOME/.local/bin"
`}`;

type Opts = { fancy?: boolean; width?: number; env?: Record<string, string> };

// runLib drives the sourced helpers in a clean bash. The ambient NO_COLOR /
// TFM_* variables are scrubbed so a developer's own environment can't decide
// what the test renders.
const runLib = (script: string, opts: Opts = {}) => {
  const env: Record<string, string> = { ...process.env, TFM_INSTALL_LIB_ONLY: "1", ...opts.env };
  for (const k of [
    "NO_COLOR",
    "CI",
    "TFM_WIDTH",
    "TFM_INSTALL_DIR",
    "TFM_VERSION",
    "TFM_SOURCE",
    "TFM_LOCAL",
    "TFM_VERBOSE",
  ]) {
    delete env[k];
  }
  const prelude = `${PRELUDE}FANCY=${opts.fancy === false ? 0 : 1}\nCOLS=${opts.width ?? 80}\n`;
  const res = Bun.spawnSync({
    cmd: ["bash", "-c", prelude + script],
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const raw = res.stdout.toString();
  return { raw, out: strip(raw), err: res.stderr.toString(), code: res.exitCode };
};

// biome's noControlCharactersInRegex rejects a literal ESC in a regex, and the
// installer emits real SGR sequences, so the byte is spliced in at runtime.
const ESC = "\u001b";
const SGR = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");
const CSI = new RegExp(`^${ESC}\\[[0-9;]*([A-Za-z])`);

const strip = (s: string) => s.replace(SGR, "");

// Replay the stream the way a terminal does: \r goes back to column 0 and \e[K
// erases to the end of the line, so a pending line that was never overwritten
// shows up as garbage here instead of hiding behind an escape code.
const paint = (raw: string): string[] => {
  const lines: string[] = [];
  let cur = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (ch === "\r") {
      cur = "";
      continue;
    }
    if (ch === ESC) {
      const seq = CSI.exec(raw.slice(i));
      if (seq) {
        if (seq[1] === "K") cur = "";
        i += seq[0].length - 1;
        continue;
      }
    }
    if (ch === "\n") {
      lines.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) lines.push(cur);
  return lines;
};

const cols = (s: string) => [...s].length; // every glyph we draw is one code point

// The text inside the borders, so a wrapped command can be reassembled across
// lines (the box characters sit between the fragments otherwise).
const panelBody = (lines: string[]) =>
  lines.filter((l) => /^ {2}│/.test(l)).map((l) => l.replace(/^ {2}│/, "").replace(/│$/, ""));

const osRelease = (id: string, like = "") => {
  const dir = mkdtempSync(join(tmpdir(), "tfm-osrelease-"));
  const path = join(dir, "os-release");
  writeFileSync(path, `NAME="Test"\nID=${id}\nID_LIKE=${like}\n`);
  return path;
};

// install_binary writes into $DEST for real, so every case gets its own sandbox.
// mkdtempSync only creates the last segment, hence the os.tmpdir() parent: a
// literal /tmp/... parent cost a CI round-trip once.
type Sandbox = {
  dest: string;
  work: string;
  stubs: string;
  run: (body: string, opts?: Opts) => ReturnType<typeof runLib>;
};

const sandbox = (): Sandbox => {
  const dir = mkdtempSync(join(tmpdir(), "tfm-install-"));
  const dest = join(dir, "bin");
  const work = join(dir, "work");
  const stubs = join(dir, "stubs");
  mkdirSync(dest);
  mkdirSync(work);
  mkdirSync(stubs);
  const run = (body: string, opts: Opts = {}) =>
    runLib(`DEST='${dest}'\nWORK='${work}'\nRUN_LOG=$WORK/install.log\n${body}\n`, opts);
  return { dest, work, stubs, run };
};

// A stand-in for a compiled tfm: install_binary only needs it to answer
// `--version` (or to fail, in the negative case).
const stage = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

const RUNS = 'echo "tfm 9.9.9"';

describe("installer width", () => {
  // The original bug: `${#s}` under LC_ALL=C counts bytes, so `·` measured 2
  // columns and every right border sat one column out.
  test("a multibyte glyph counts as one column, in both counting paths", () => {
    expect(runLib(`disp_w '·✓✗→─'`).out).toBe("5");
    // the no-C.UTF-8 fallback has to agree, or musl users get the old misalignment
    expect(runLib(`U8=0; disp_w '·✓✗→─'`).out).toBe("5");
    expect(runLib(`U8=0; disp_w 'plain ascii'`).out).toBe("11");
  });
});

describe("installer steps", () => {
  test("a finished step replaces its pending line instead of stacking under it", () => {
    const { raw } = runLib(`step_begin download\nstep_ok "18.8 MB · tfm-x86_64-linux.gz"\n`);
    const lines = paint(raw).filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("  ✓  download    18.8 MB · tfm-x86_64-linux.gz");
  });

  test("labels share one column so the details read as a list", () => {
    const { raw } = runLib(`step_begin download\nstep_ok "18.8 MB"\nstep_begin check\nstep_ok "tfm 0.1.1 runs"\n`);
    const lines = paint(raw).filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.indexOf("18.8 MB")).toBe(17);
    expect(lines[1]?.indexOf("tfm 0.1.1 runs")).toBe(17);
  });

  test("a failure marks the step, names the action, and exits 1", () => {
    const { out, code } = runLib(
      `step_begin install\nfail_at install "move failed" "Couldn't write /nowhere/tfm." "Check permissions and free space."\n`,
      { fancy: false },
    );
    expect(code).toBe(1);
    expect(out).toContain("tfm: FAILED install, move failed");
    expect(out).toContain("Couldn't write /nowhere/tfm.");
    expect(out).toContain("Check permissions and free space.");
  });

  test("plain mode prints one factual line per step", () => {
    expect(runLib(`step_begin download\nstep_ok "18.8 MB"\n`, { fancy: false }).out).toBe("tfm: download, 18.8 MB\n");
  });

  test("plain mode never reports a warning as a success", () => {
    const { out } = runLib(`step_begin check\nstep_warn "installed, but it didn't run"\n`, { fancy: false });
    expect(out).toBe("tfm: warning: check, installed, but it didn't run\n");
  });
});

describe("installer panel", () => {
  const result = (extra = "") => `
SMOKE_VER="0.1.1-beta.0"
path_action=ready
${extra}
print_result
`;

  test("borders line up and stay inside the terminal", () => {
    for (const width of [62, 80, 120]) {
      const lines = paint(runLib(result(), { width }).raw).filter(Boolean);
      const widths = new Set(lines.map(cols));
      expect(widths.size).toBe(1);
      const [only] = [...widths];
      expect(only).toBeLessThanOrEqual(width);
      expect(lines[0]).toStartWith("  ╭");
    }
  });

  test("a deep install path wraps inside the panel instead of overflowing", () => {
    const hint = 'export PATH="$HOME/very/deep/nested/install/location/bin:$PATH"';
    const { raw } = runLib(`path_action=export\nexport_hint='${hint}'\nprint_result\n`, { width: 62 });
    const lines = paint(raw).filter(Boolean);
    for (const line of lines) expect(cols(line)).toBeLessThanOrEqual(62);
    // wrapped, never truncated: the whole command is still on screen
    expect(panelBody(lines).join(" ").replace(/\s+/g, "")).toContain(hint.replace(/\s+/g, ""));
    expect(cols(lines[0] as string)).toBe(cols(lines[1] as string));
  });

  test("a '> ' line is drawn as an indented command", () => {
    const lines = paint(runLib(`panel "$C_OK" "then start it:" "> tfm"\n`).raw).filter(Boolean);
    expect(lines.some((l) => /^ {2}│ {6}tfm /.test(l))).toBe(true);
    expect(lines.join("")).not.toContain("> tfm"); // the marker itself is never printed
  });

  // The fancy/plain decision is made once, at load, from the real terminal (a
  // tty, no NO_COLOR/CI, a capable TERM and >= 60 columns) — so this one needs a
  // pty, and it must set TERM itself: GitHub Actions exports TERM=dumb, which
  // the installer correctly reads as "draw nothing", and then this test would
  // pass by accident instead of testing the width gate it is about.
  test.skipIf(!Bun.which("script"))("a terminal narrower than 60 columns gets plain lines", () => {
    const render = (width: number) => {
      const inner = `env -u NO_COLOR -u CI TERM=xterm-256color TFM_INSTALL_LIB_ONLY=1 TFM_WIDTH=${width} bash -c 'source install.sh; SMOKE_VER=0.1.1-beta.0; path_action=ready; print_result'`;
      const res = Bun.spawnSync({
        cmd: ["script", "-qec", inner, "/dev/null"],
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      return res.stdout.toString();
    };
    expect(render(80)).toContain("╭");
    const narrow = render(59);
    expect(narrow).not.toContain("╭");
    expect(narrow).toContain("tfm: installed to");
  });

  test("plain mode prints the same facts without a box", () => {
    const { out } = runLib(result(`\nreload_cmd="source ~/.bashrc"\npath_action=reload\n`), { fancy: false });
    expect(out).not.toContain("╭");
    expect(out).toContain("tfm: tfm 0.1.1-beta.0 is ready");
    expect(out).toContain("tfm: installed to ~/.local/bin/tfm");
    expect(out).toContain("tfm: source ~/.bashrc");
    expect(out).toContain("tfm: tfm");
  });

  // Both command names are the same binary, so the start line has to offer both
  // — otherwise a user who wants `terminal-file-manager` never hears about it.
  test("the start command names both commands", () => {
    const lines = paint(runLib(result(), { width: 80 }).raw).filter(Boolean);
    expect(lines.some((l) => /^ {2}│ {6}tfm or terminal-file-manager /.test(l))).toBe(true);
    const { out } = runLib(result(), { fancy: false });
    expect(out).toContain("tfm: tfm or terminal-file-manager");
  });
});

describe("installer install", () => {
  // The user-visible promise of this step: the previous binary is replaced, and
  // nothing extra is left lying next to it (the old flow kept a 100 MB tfm.bak).
  test("replacing an existing binary leaves no .bak behind", () => {
    const { dest, work, run } = sandbox();
    writeFileSync(join(dest, "tfm"), "OLD");
    stage(join(work, "new"), RUNS);

    expect(run(`install_binary "$WORK/new"`).code).toBe(0);
    expect(readFileSync(join(dest, "tfm"), "utf8")).toContain("tfm 9.9.9");
    expect(existsSync(join(dest, "tfm.bak"))).toBe(false);
    // both commands exist and both point at the installed binary
    expect(readlinkSync(join(dest, "terminal-file-manager"))).toBe(join(dest, "tfm"));
  });

  // The run test moved in FRONT of the swap, which is what makes the backup
  // unnecessary: a build that doesn't start must change nothing at all.
  test("a build that doesn't run changes nothing in the install dir", () => {
    const { dest, work, run } = sandbox();
    writeFileSync(join(dest, "tfm"), "OLD");
    writeFileSync(join(dest, "tfm.bak"), "ANCIENT");
    stage(join(work, "new"), "exit 3");

    const { code, out } = run(`install_binary "$WORK/new"`);
    expect(code).toBe(1);
    expect(out).toContain("didn't report its version");
    expect(readFileSync(join(dest, "tfm"), "utf8")).toBe("OLD");
    expect(existsSync(join(dest, "terminal-file-manager"))).toBe(false);
    // the sweep only runs after a successful swap
    expect(readFileSync(join(dest, "tfm.bak"), "utf8")).toBe("ANCIENT");
  });

  // The window the old backup existed for: everything before the swap succeeded,
  // the swap itself fails (disk full, a path in the way). Whatever happens, the
  // binary you could run a moment ago is still there — the old flow moved it to
  // tfm.bak first, then renamed onto the emptied path, and could end up with a
  // mangled install instead of a failure.
  test("a failed swap leaves the previous binary in place", () => {
    const { dest, work, run } = sandbox();
    writeFileSync(join(dest, "tfm"), "OLD");
    stage(join(work, "new"), RUNS);
    // a directory where the temp file goes: the final rename can't overwrite it
    const { code, out } = run(`mkdir -p "$DEST/.tfm-new.$$"\ninstall_binary "$WORK/new"`);

    expect(code).toBe(1);
    expect(out).toContain("Couldn't write");
    expect(readFileSync(join(dest, "tfm"), "utf8")).toBe("OLD");
    expect(existsSync(join(dest, "tfm.bak"))).toBe(false);
  });

  test("TFM_NO_SMOKE=1 installs without running the build", () => {
    const { dest, work, run } = sandbox();
    stage(join(work, "new"), "exit 3");

    const { code } = run(`install_binary "$WORK/new"`, { env: { TFM_NO_SMOKE: "1" } });
    expect(code).toBe(0);
    expect(readFileSync(join(dest, "tfm"), "utf8")).toContain("exit 3");
  });

  test("an old tfm.bak is removed once the new binary is in place", () => {
    const { dest, work, run } = sandbox();
    writeFileSync(join(dest, "tfm"), "OLD");
    writeFileSync(join(dest, "tfm.bak"), "ANCIENT");
    stage(join(work, "new"), RUNS);

    expect(
      run(`BAK_REMOVED=0
install_binary "$WORK/new"
printf 'bak=%s' "$BAK_REMOVED"`).out,
    ).toBe("bak=1");
    expect(existsSync(join(dest, "tfm.bak"))).toBe(false);
  });

  // A directory squatting on the second name is the one collision we can detect
  // up front, so it must abort BEFORE the installed binary is touched.
  test("a directory in the way of the second name aborts before the swap", () => {
    const { dest, work, run } = sandbox();
    writeFileSync(join(dest, "tfm"), "OLD");
    mkdirSync(join(dest, "terminal-file-manager"));
    stage(join(work, "new"), RUNS);

    const { code, out } = run(`install_binary "$WORK/new"`);
    expect(code).toBe(1);
    expect(out).toContain("is a directory");
    expect(readFileSync(join(dest, "tfm"), "utf8")).toBe("OLD");
  });

  test("smoke_version reads the version a build reports", () => {
    const { work, run } = sandbox();
    stage(join(work, "good"), RUNS);
    stage(join(work, "weird"), 'echo "not a tfm build"');

    expect(run(`smoke_version "$WORK/good"\nprintf '%s' "$SMOKE_VER"`).out).toBe("9.9.9");
    // exit 0 is not enough: the output has to be a tfm version line
    expect(run(`smoke_version "$WORK/weird" || printf 'rejected'`).out).toBe("rejected");
  });
});

describe("installer packager hint", () => {
  test("the detected packager follows /etc/os-release", () => {
    const cases: [string, string, string][] = [
      ["cachyos", "arch", "pacman"],
      ["debian", "", "apt"],
      ["ubuntu", "debian", "apt"],
      ["fedora", "", "dnf"],
      ["alpine", "", "apk"],
      ["opensuse-tumbleweed", "suse", "zypper"],
      ["plan9", "", ""],
    ];
    for (const [id, like, want] of cases) {
      const { out } = runLib(`detect_pm\n`, { env: { TFM_OS_RELEASE: osRelease(id, like) } });
      expect(`${id}: ${out}`).toBe(`${id}: ${want}`);
    }
  });

  test("package names are only suggested where we know them", () => {
    expect(runLib(`pm_pkg apt gio\n`).out).toBe("libglib2.0-bin");
    expect(runLib(`pm_pkg pacman gio\n`).out).toBe("glib2");
    expect(runLib(`pm_pkg apk gio\n`).out).toBe("glib");
    expect(runLib(`pm_pkg apt ffmpeg\n`).out).toBe("ffmpeg");
    // resvg is not reliably packaged anywhere: no `sudo apt install resvg` lies
    expect(runLib(`pm_pkg apt resvg\n`).out).toBe("");
    expect(runLib(`pm_cmd zypper\n`).out).toBe("sudo zypper install");
  });
});

describe("installer download bar", () => {
  // A stub curl with just the flag surface fetch_with_bar uses: a combined
  // short-flag token containing I answers a HEAD, -D dumps response headers, -o
  // writes the body — in two pieces when hold is set, so the poll loop sees the
  // file grow. The child holding the loop open is the point: no test-side sleep
  // waits for anything.
  const stubCurl = (
    dir: string,
    o: { bytes: number; hold?: boolean; status?: number; noLength?: boolean; headFails?: boolean },
  ) => {
    const half = Math.floor(o.bytes / 2);
    const header = o.noLength
      ? "printf 'HTTP/2 200\\r\\ntransfer-encoding: chunked\\r\\n'"
      : `printf 'HTTP/2 200\\r\\nContent-Length: ${o.bytes}\\r\\n'`;
    const script = [
      "#!/bin/sh",
      'out=""; hdr=""; head=0',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      "    -o) out=$2; shift 2 ;;",
      "    -D) hdr=$2; shift 2 ;;",
      '    -*) case "$1" in *I*) head=1 ;; esac; shift ;;',
      "    *) shift ;;",
      "  esac",
      "done",
      o.headFails ? 'if [ "$head" = 1 ]; then exit 8; fi' : `if [ "$head" = 1 ]; then ${header}; exit 0; fi`,
      `[ -n "$hdr" ] && ${header} >"$hdr"`,
      ...(o.hold
        ? [`head -c ${half} /dev/zero >"$out"`, "sleep 0.6", `head -c ${o.bytes - half} /dev/zero >>"$out"`]
        : [`head -c ${o.bytes} /dev/zero >"$out"`]),
      `exit ${o.status ?? 0}`,
      "",
    ].join("\n");
    writeFileSync(join(dir, "curl"), script);
    chmodSync(join(dir, "curl"), 0o755);
  };
  const withStub = (dir: string) => ({ PATH: `${dir}:${process.env.PATH ?? ""}` });

  test("a bar is exactly as wide as its budget, at every percentage", () => {
    for (const [w, pct] of [
      [10, 0],
      [10, 54],
      [10, 100],
      [10, 200],
      [7, 33],
      [1, 50],
    ] as const) {
      const out = runLib(`bar_for ${w} ${pct}`).out;
      // columns, not code points: each block glyph is three bytes
      expect(runLib(`disp_w "$(bar_for ${w} ${pct})"`).out).toBe(String(w));
      expect([...out].filter((c) => c === "█").length).toBe(Math.round((w * Math.min(pct, 100)) / 100));
    }
  });

  test("the indeterminate sweep stays inside its track", () => {
    for (const pos of [0, 5, 12, 20, -4]) {
      const out = runLib(`sweep_for 20 ${pos}`).out;
      expect([...out].length).toBe(20);
      expect(out.match(/█+/g)).toHaveLength(1); // one window, never a second run
      expect([...out].filter((c) => c === "█").length).toBe(10);
    }
  });

  test("stats degrade before the bar becomes unusable", () => {
    const at = (width: number) =>
      runLib(
        `progress_stats '54% · 12.4 MB/s · 0:02' '54% · 12.4 MB/s' '54%'\nprintf '%s|%s' "$STATS_TEXT" "$STATS_W"`,
        { width },
      ).out;
    expect(at(80)).toBe("54% · 12.4 MB/s · 0:02|39");
    expect(at(120)).toBe("54% · 12.4 MB/s · 0:02|40"); // BAR_MAX caps a ribbon
    expect(at(60)).toBe("54% · 12.4 MB/s · 0:02|19");
    expect(at(44)).toBe("54% · 12.4 MB/s|10"); // ETA is the first to go
    expect(at(30)).toBe("54%|8"); // then speed, and the bar sits at BAR_MIN
    // below BAR_MIN's floor the raw math would go negative: the bar holds its
    // minimum because a bar that can't be drawn is worse than a short one
    expect(at(24)).toBe("54%|8");
    for (const width of [60, 80, 120]) {
      const [text, w] = at(width).split("|") as [string, string];
      expect(17 + 2 + cols(text) + Number(w)).toBeLessThanOrEqual(width);
    }
  });

  test("speed and ETA read like the rest of the installer", () => {
    // hsize's own whole/decimal rule does the formatting: 12.5 MB exactly
    expect(runLib(`fmt_speed 13107200`).out).toBe("12.5 MB/s");
    expect(runLib(`fmt_speed 421888`).out).toBe("412 KB/s");
    expect(runLib(`fmt_speed 0`).out).toBe("—");
    expect(runLib(`fmt_speed ''`).out).toBe("—");
    // garbage must never reach hsize's arithmetic: that would abort mid-download
    expect(runLib(`fmt_speed nope`).out).toBe("—");
    expect(runLib(`fmt_eta 1500`).out).toBe("0:02"); // rounded up, never 0:00
    expect(runLib(`fmt_eta 65000`).out).toBe("1:05");
    expect(runLib(`fmt_eta 3700000`).out).toBe("1:01:40");
    expect(runLib(`fmt_eta ''`).out).toBe("—");
  });

  test("the size comes from the last hop of a redirect chain", () => {
    const hop = "HTTP/2 302\\r\\ncontent-length: 0\\r\\nlocation: https://objects.example/x\\r\\n\\r\\n";
    const last = "HTTP/2 200\\r\\nContent-Length: 41440128\\r\\ncontent-type: application/octet-stream\\r\\n";
    expect(runLib(`printf '${hop}${last}' | hdr_length`).out).toBe("41440128");
    // chunked: no honest total, so the row must sweep instead of inventing one
    expect(runLib(`printf 'HTTP/2 200\\r\\ntransfer-encoding: chunked\\r\\n' | hdr_length`).out).toBe("");
  });

  test("a repaint overwrites the pending row and stops at the terminal edge", () => {
    for (const width of [60, 80, 120]) {
      const { raw } = runLib(
        `STEP_LABEL=download\nprogress_stats '54% · 12.4 MB/s · 0:02' '54% · 12.4 MB/s' '54%'\nprogress_paint "$(bar_for $STATS_W 54)" "$STATS_TEXT"`,
        { width },
      );
      const [row] = paint(raw);
      expect(row).toBeDefined();
      expect(cols(row as string)).toBeLessThanOrEqual(width);
      expect(row).toStartWith("  ·  download  ");
      expect(row).toContain("█");
      expect(row).toContain("54%");
      expect(raw).toStartWith("\r\u001b[K"); // the pending-line idiom
      expect(raw).not.toContain("\n"); // no newline: step_ok replaces the row
    }
    // plain mode (pipes, CI, NO_COLOR, narrow terminals) draws nothing at all
    expect(runLib(`STEP_LABEL=download\nprogress_paint bar stats`, { fancy: false }).raw).toBe("");
  });

  test("a live download drives the bar and lands on the step row", () => {
    const { stubs, work, run } = sandbox();
    stubCurl(stubs, { bytes: 8192, hold: true });
    const { raw, code } = run(`fetch_with_bar https://example.invalid/x "$WORK/out" "$WORK/hdr"`, {
      env: withStub(stubs),
    });
    expect(code).toBe(0);
    expect(readFileSync(join(work, "out")).length).toBe(8192);
    expect(raw).toContain("50%"); // painted while the child held it half-written
    // the stats ride along on the same frames: a speed and an ETA, not blanks
    expect(raw).toMatch(/\d+(\.\d+)? (B|KB|MB)\/s/);
    expect(raw).toMatch(/\d:\d\d/);
    expect(raw).toContain("\r\u001b[K");
    expect(raw.endsWith("\n")).toBe(false);
  });

  test("fetch_length reads the size out of a HEAD request", () => {
    const { stubs, run } = sandbox();
    stubCurl(stubs, { bytes: 41440128 });
    const { out, code } = run("fetch_length https://example.invalid/x", { env: withStub(stubs) });
    expect(code).toBe(0);
    expect(out).toBe("41440128");
  });

  // The HEAD is an optimisation, not a requirement: plenty of CDNs refuse it,
  // and the download's own response headers then supply the total.
  test("a server that refuses HEAD still gets a percentage from the download", () => {
    const { stubs, work, run } = sandbox();
    stubCurl(stubs, { bytes: 8192, hold: true, headFails: true });
    const { raw, code } = run(`fetch_with_bar https://example.invalid/x "$WORK/out" "$WORK/hdr"`, {
      env: withStub(stubs),
    });
    expect(code).toBe(0);
    expect(raw).toContain("50%");
    expect(readFileSync(join(work, "out")).length).toBe(8192);
  });

  test("a server that never names the size gets the sweep, not a fake percentage", () => {
    const { stubs, run } = sandbox();
    stubCurl(stubs, { bytes: 8192, hold: true, noLength: true });
    const { raw, code } = run(`fetch_with_bar https://example.invalid/x "$WORK/out" "$WORK/hdr"`, {
      env: withStub(stubs),
    });
    expect(code).toBe(0);
    expect(raw).toContain("░");
    expect(raw).not.toContain("%");
  });

  test("a failing download returns curl's status instead of a success row", () => {
    const { stubs, run } = sandbox();
    stubCurl(stubs, { bytes: 4096, status: 22 });
    const { code } = run(`fetch_with_bar https://example.invalid/x "$WORK/out" "$WORK/hdr"`, {
      env: withStub(stubs),
    });
    expect(code).toBe(22);
  });
});
