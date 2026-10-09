// --- Key specs: the pure keybind vocabulary (parse / validate / match /
// compare) — split out of config-schema.ts, which stays the ONE table of
// config keys. Nothing here knows the table: `keybindConflict` (the check that
// needs KEY_ROWS) deliberately stays with it, so this module imports nothing
// and can be pulled in by the keymap, the settings capture UI and the plugin
// loader without dragging the schema along. ---

export type KeySpec = { name: string; ctrl: boolean; shift: boolean; meta: boolean };

export const parseKeySpec = (s: string): KeySpec | null => {
  if (typeof s !== "string") return null;
  const parts = s
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return null;
  const spec: KeySpec = { name: "", ctrl: false, shift: false, meta: false };
  for (const p of parts) {
    if (p === "ctrl" || p === "control") spec.ctrl = true;
    else if (p === "shift") spec.shift = true;
    else if (p === "alt" || p === "meta" || p === "option") spec.meta = true;
    else if (spec.name)
      return null; // two key names
    else spec.name = p;
  }
  if (!spec.name) return null;
  return spec;
};

// bare unmodified printable keys feed type-to-search — binding them to an
// action would make the action unreachable in the grid
const BARE_KEY_RE = /^[a-z0-9._-]$/;

// multi-char key names OpenTUI's parser can produce (single printable chars
// are matched by length); anything else is garbage and rejected at parse time
const KNOWN_KEY_NAMES = new Set([
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
  "escape",
  "return",
  "enter",
  "tab",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  "space",
  "menu",
  "clear",
  "capslock",
  "numlock",
  "scrolllock",
  "printscreen",
  "pause",
  "contextmenu",
]);

export const validateKeybindSpec = (s: string): string | null => {
  const spec = parseKeySpec(s);
  if (!spec) return `can't parse key "${s}"`;
  if (BARE_KEY_RE.test(spec.name) && !spec.ctrl && !spec.shift && !spec.meta)
    return "bare letters/numbers are used for type-to-search";
  if (spec.name.length > 1 && !KNOWN_KEY_NAMES.has(spec.name)) return `unknown key "${spec.name}"`;
  if (spec.name.length === 1 && !/[a-z0-9._-]/i.test(spec.name) && !spec.ctrl && !spec.meta)
    return "symbol keys must carry ctrl/alt";
  return null;
};

// mirror OpenTUI's matcher (keybinding.internal.ts): name + modifiers, with
// the kitty base-layout codepoint as a fallback for non-Latin layouts
export type KeyEventLike = {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  option?: boolean;
  baseCode?: number;
};

export const keyMatch = (e: KeyEventLike, spec: KeySpec): boolean => {
  if (!!e.ctrl !== spec.ctrl || !!e.shift !== spec.shift || (!!e.meta || !!e.option) !== spec.meta) return false;
  if (e.name === spec.name) return true;
  const bc = e.baseCode;
  if (typeof bc === "number" && bc >= 32 && bc !== 127) {
    try {
      if (String.fromCodePoint(bc).toLowerCase() === spec.name) return true;
    } catch {}
  }
  return false;
};

export const keySpecFromEvent = (e: KeyEventLike): string | null => {
  const name = typeof e.name === "string" ? e.name.trim().toLowerCase() : "";
  if (!name || name.length > 24) return null;
  const mods = [e.ctrl ? "ctrl" : "", e.shift ? "shift" : "", e.meta || e.option ? "alt" : ""].filter(Boolean);
  return [...mods, name].join("+");
};

// OpenTUI reports Enter as "return" (kitty/legacy forms vary) — the router
// accepts both spellings, so conflict checks must treat them as one key or
// an enter/return collision passes validation but shadows at runtime.
const canonKeyName = (name: string): string => (name === "enter" || name === "return" ? "enter" : name);

// spec-string equality for conflict checks (modifiers + canonical name).
// Shared by keybindConflict and the plugin bind checks in settings-model —
// one comparator so validation and dispatch can't disagree. (The runtime
// baseCode fallback in keyMatch is event-specific and stays in the router.)
export const keySpecEqual = (a: string, b: string): boolean => {
  const pa = parseKeySpec(a);
  const pb = parseKeySpec(b);
  return (
    !!pa &&
    !!pb &&
    canonKeyName(pa.name) === canonKeyName(pb.name) &&
    pa.ctrl === pb.ctrl &&
    pa.shift === pb.shift &&
    pa.meta === pb.meta
  );
};
