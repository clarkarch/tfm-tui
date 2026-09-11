// --- Config file IO. All key definitions, defaults, parsing rules, the
// serializer (with regenerated doc comments) and the example TOML live in
// ./config-schema — this module is just file location + read/write. ---
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { atomicWriteFile } from "../fs/fsutil";
import { parseConfigDoc, serializeConfig, type Config } from "./config-schema";

export { defaultConfig } from "./config-schema";
export type { Config, Theme, UiConfig } from "./config-schema";

export function configPath(): string {
  if (process.env.TFM_CONFIG) return process.env.TFM_CONFIG;
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "tfm", "config.toml");
}

export function loadConfig(): Config {
  const file = configPath();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return parseConfigDoc(undefined);
  }

  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    console.error(`[tfm] ignoring malformed config ${file}: ${err}`);
    return parseConfigDoc(undefined);
  }
  return parseConfigDoc(doc);
}

export async function saveConfig(cfg: Config): Promise<void> {
  const file = configPath();
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, serializeConfig(cfg));
}
