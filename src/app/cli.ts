// --- CLI argument grammar: `tfm [OPTIONS] [PATH]`. Pure (no fs, no process
// probing) so index.ts can answer --help/--version before the lazy app graph
// loads, and tests can drive every spelling. Handles both layouts: `bun
// src/index.ts PATH` (argv[1] is the script) and the compiled `tfm PATH`
// (argv[1] is the first user arg). GNU-style permutation: flags may appear
// before or after the path. `--` ends option parsing. ---

import pkg from "../../package.json";

export type CliOptions = {
  help: boolean;
  version: boolean;
  config: string | null;
  paths: string[];
  // first parse failure; when set, callers print it + usage hint and exit 2
  error: string | null;
};

export const parseArgs = (argv: string[]): CliOptions => {
  const opts: CliOptions = { help: false, version: false, config: null, paths: [], error: null };
  let args = argv.slice(1);
  // `bun src/index.ts PATH` has the script as argv[1]; the compiled `tfm PATH`
  // does not. Only strip under a JS runner — otherwise a real path named
  // `index.js` (or `path/index.ts`) passed to the compiled binary is swallowed.
  const runner = (argv[0] ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  if (/^(bun|node|deno)(\.exe)?$/.test(runner) && args.length && /index\.[tj]s$/.test(args[0] as string)) {
    args = args.slice(1);
  }

  const fail = (msg: string): CliOptions => {
    opts.error = msg;
    return opts;
  };

  let endOpts = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (endOpts) {
      opts.paths.push(a);
      continue;
    }
    if (a === "--") {
      endOpts = true;
      continue;
    }
    if (a === "-h" || a === "--help") {
      opts.help = true;
      continue;
    }
    if (a === "-v" || a === "--version") {
      opts.version = true;
      continue;
    }
    // --debug/-d is consumed by ./log (which still scans argv); accepted here
    if (a === "-d" || a === "--debug") continue;
    if (a === "-c" || a === "--config") {
      const v = args[++i];
      if (v === undefined || v === "") return fail(`option '${a}' needs a value`);
      opts.config = v;
      continue;
    }
    if (a.startsWith("--config=")) {
      const v = a.slice("--config=".length);
      if (v === "") return fail("option '--config' needs a value");
      opts.config = v;
      continue;
    }
    if (a.startsWith("-c") && a.length > 2) {
      opts.config = a.slice(2);
      continue;
    }
    // a lone "-" is a path (rare but valid); anything else dash-led is unknown
    if (a.startsWith("-") && a !== "-") return fail(`unknown option '${a}'`);
    opts.paths.push(a);
  }
  return opts;
};

export const usageText = (): string => `tfm ${pkg.version} — terminal file manager

Usage: tfm [OPTIONS] [PATH]

  PATH               directory to open (default: current dir). A file opens
                     its parent folder and selects that file.

Options:
  -h, --help         show this help and exit
  -v, --version      print version and exit
  -d, --debug        write a verbose event log (for bug reports)
  -c, --config FILE  use FILE instead of ~/.config/tfm/config.toml
  --                 treat the rest as PATH (names that start with '-')
`;
