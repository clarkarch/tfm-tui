// --- OSC 72 (kitty drag-and-drop) pure protocol helpers: frame builders,
// meta-string parser and drop-payload decoding. All bytes here are
// byte-exact with yazi's reference implementation; ./dnd72 owns the
// write/log/state-machine side. ---

// path -> file:// uri, escaping every segment except the root slashes
export const percentEncodePath = (p: string): string => encodeURIComponent(p).replace(/%2F/g, "/");

// enter/ready (t=m/t=M) meta string -> fields. x/y are NaN when absent;
// m means "more chunks coming".
export type Osc72Meta = { t: string; x: number; y: number; m: boolean };

export const parseOsc72Meta = (meta: string): Osc72Meta => {
  let t = "";
  let x = NaN,
    y = NaN,
    m = false;
  for (const part of meta.split(":")) {
    const [k, v] = part.split("=");
    if (k === "t") t = v ?? "";
    else if (k === "x") x = parseInt(v ?? "", 10);
    else if (k === "y") y = parseInt(v ?? "", 10);
    else if (k === "m") m = v === "1";
  }
  return { t, x, y, m };
};

// unpadded base64 (like yazi) of a CRLF-joined file:// uri-list
export const uriListPayload = (paths: string[]): string =>
  Buffer.from(paths.map((p) => `file://${percentEncodePath(p)}`).join("\r\n"), "utf8")
    .toString("base64")
    .replace(/=+$/, "");

// text/plain badge shown next to the cursor for the whole drag session
export const dragBadgeLabel = (n: number): string => `${n} item${n === 1 ? "" : "s"}`;

// --- wire frames (terminator is ST: ESC \) ---

// trailing ; = empty machine-id, byte-exact w/ yazi
export const dragOutEnableFrame = (): string => "\x1b]72;t=o:x=1;\x1b\\";
export const dropInEnableFrame = (): string => "\x1b]72;t=a;text/uri-list\x1b\\";
export const dropDisableFrame = (): string => "\x1b]72;t=A\x1b\\";

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
export const startDropFrame = (uriIdx: number): string => `\x1b]72;t=r:x=${uriIdx}\x1b\\`;
export const finishDropFrame = (): string => "\x1b]72;t=r:o=1\x1b\\";
export const selfDropRejectFrame = (): string => "\x1b]72;t=r:o=0\x1b\\";

// drop payload -> local paths. file:// lines are decoded; some sources
// deliver bare absolute paths (text/plain) instead — accept those too.
export const uriListToPaths = (data: string): string[] =>
  data
    .split(/\r?\n/)
    .filter((l) => l.startsWith("file://"))
    .map((l) => {
      let u = l.slice(7);
      if (!u.startsWith("/")) u = u.slice(u.indexOf("/") + 1);
      try {
        u = decodeURIComponent(u);
      } catch {}
      return u;
    });

export const dropPayloadToPaths = (text: string): string[] => {
  const paths = uriListToPaths(text);
  return paths.length ? paths : text.split(/\r?\n/).filter((l) => l.startsWith("/"));
};
