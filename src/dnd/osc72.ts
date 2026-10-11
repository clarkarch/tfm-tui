// --- OSC 72 (kitty drag-and-drop) pure protocol helpers: frame builders,
// meta-string parser and drop-payload decoding. All bytes here are
// byte-exact with yazi's reference implementation; ./dnd72 owns the
// write/log/state-machine side. ---

import { fileUriToPath, pathToUri } from "../fs/uri";

// path -> file:// uri, escaping every segment except the root slashes
export const percentEncodePath = (p: string): string => pathToUri(p).slice(7);

// enter/ready (t=m/t=M) meta string -> fields. x/y/X/Y are NaN when absent
// (X=0 is meaningful on the remote file-serve path — regular file — so absent
// must stay distinguishable from 0); i/o default 0; m means "more chunks coming".
type Osc72Meta = { t: string; x: number; y: number; X: number; Y: number; i: number; o: number; m: boolean };

export const parseOsc72Meta = (meta: string): Osc72Meta => {
  let t = "";
  let x = NaN,
    y = NaN,
    X = NaN,
    Y = NaN,
    i = 0,
    o = 0,
    m = false;
  for (const part of meta.split(":")) {
    const [k, v] = part.split("=");
    if (k === "t") t = v ?? "";
    else if (k === "x") x = parseInt(v ?? "", 10);
    else if (k === "y") y = parseInt(v ?? "", 10);
    else if (k === "X") X = parseInt(v ?? "", 10);
    else if (k === "Y") Y = parseInt(v ?? "", 10);
    else if (k === "i") i = parseInt(v ?? "", 10) || 0;
    else if (k === "o") o = parseInt(v ?? "", 10) || 0;
    else if (k === "m") m = v === "1";
  }
  return { t, x, y, X, Y, i, o, m };
};

// unpadded base64 (like yazi) of a CRLF-joined file:// uri-list
export const uriListPayload = (paths: string[]): string =>
  Buffer.from(paths.map((p) => `file://${percentEncodePath(p)}`).join("\r\n"), "utf8")
    .toString("base64")
    .replace(/=+$/, "");

// text/plain badge shown next to the cursor for the whole drag session
export const dragBadgeLabel = (n: number): string => `${n} item${n === 1 ? "" : "s"}`;

// --- wire frames (terminator is ST: ESC \) ---

// id omitted (= trailing ;) when unknown, byte-exact w/ yazi
export const dragOutEnableFrame = (id = ""): string => `\x1b]72;t=o:x=1;${id}\x1b\\`;
export const dropInEnableFrame = (): string => "\x1b]72;t=a;text/uri-list\x1b\\";
export const dropDisableFrame = (): string => "\x1b]72;t=A\x1b\\";
// drop-side machine-id declaration: lets kitty flag cross-machine payloads
// (X=1) so remote drops are detected instead of misread as local paths
export const dropMachineIdFrame = (id: string): string => `\x1b]72;t=a:x=1;${id}\x1b\\`;

// accept a drag-out offer for either operation, then grab the pointer
export const agreeDragFrame = (): string => "\x1b]72;t=o:o=3;text/uri-list\x1b\\";
export const startDragFrame = (): string => "\x1b]72;t=P:x=-1\x1b\\";

// offer our payload back to the source side of the drag (request t=e;x=5)
export const presentDragFrames = (paths: string[]): [string, string] => [
  `\x1b]72;t=p:x=0:m=0;${uriListPayload(paths)}\x1b\\`,
  "\x1b]72;t=p:x=0\x1b\\",
];

// drag badge: fmt:y / size cells:X,Y / opacity / m flag — NO terminator
export const dragIconFrame = (n: number): string => {
  const label = dragBadgeLabel(n);
  const b64 = Buffer.from(label, "utf8").toString("base64").replace(/=+$/, "");
  return `\x1b]72;t=p:x=-1:y=0:X=${label.length + 2}:Y=1:o=0:m=0;${b64}\x1b\\`;
};

// incoming drops: agree, request (kitty mime indices are 1-based), ack copy
export const agreeDropFrame = (): string => "\x1b]72;t=m:o=1;text/uri-list\x1b\\";
// self-drop hover answers: o=2, the self-drop path always moves (moveInto),
// and rejects answer o=0 so kitty treats the position as not-accepted instead
// of cancelling the whole session late (spec: until the client answers, the
// terminal indicates the drop is not accepted)
export const agreeSelfDropFrame = (): string => "\x1b]72;t=m:o=2;text/uri-list\x1b\\";
export const rejectHoverFrame = (): string => "\x1b]72;t=m:o=0\x1b\\";
export const startDropFrame = (uriIdx: number): string => `\x1b]72;t=r:x=${uriIdx}\x1b\\`;
export const finishDropFrame = (): string => "\x1b]72;t=r:o=1\x1b\\";
// drop cancel: t=r with no MIME index and o=0 (canceled). Shared by the
// self-drop miss path and the remote-fetch abort path.
export const cancelDropFrame = (): string => "\x1b]72;t=r:o=0\x1b\\";
// self-drop completion handshake (mirrors t=r:o=1 on the external path)
export const finishSelfDropFrame = (): string => "\x1b]72;t=r:o=2\x1b\\";

// remote drops: per-entry fetch (both indices 1-based), dir-child fetch by
// handle, and handle release once a subtree is fully read
export const requestRemoteFileFrame = (uriIdx: number, subIdx: number): string =>
  `\x1b]72;t=r:x=${uriIdx}:y=${subIdx}\x1b\\`;
export const requestRemoteChildFrame = (handle: number, num: number): string =>
  `\x1b]72;t=r:Y=${handle}:x=${num}\x1b\\`;
export const releaseRemoteDirFrame = (handle: number): string => `\x1b]72;t=r:Y=${handle}\x1b\\`;

// remote serve: one entry's bytes as 4096-char b64 chunks (keys repeated on
// every chunk — continuations may omit them but repeaters interoperate both
// ways), then a trailing empty m=0 EOF frame. meta carries t=k + x/X/Y keys
// without the m flag.
export const serveDataFrames = (meta: string, b64: string): string[] => {
  const out: string[] = [];
  const chunks = b64.length ? Math.max(1, Math.ceil(b64.length / 4096)) : 0;
  for (let i = 0; i < chunks; i++) {
    const last = i + 1 === chunks;
    out.push(`\x1b]72;${meta}:m=${last ? 0 : 1};${b64.slice(i * 4096, (i + 1) * 4096)}\x1b\\`);
  }
  out.push(`\x1b]72;${meta}:m=0\x1b\\`);
  return out;
};

// client-side serve failure: terminal must abort the drag
export const serveErrorFrame = (name: string, desc = ""): string =>
  `\x1b]72;t=E;${name}${desc ? `:${desc}` : ""}\x1b\\`;

// drop payload -> local paths. file:// lines are decoded; some sources
// deliver bare absolute paths (text/plain) instead — accept those too.
export const uriListToPaths = (data: string): string[] =>
  data
    .split(/\r?\n/)
    .filter((l) => l.startsWith("file://"))
    .map(fileUriToPath);

export const dropPayloadToPaths = (text: string): string[] => {
  const paths = uriListToPaths(text);
  return paths.length ? paths : text.split(/\r?\n/).filter((l) => l.startsWith("/"));
};
