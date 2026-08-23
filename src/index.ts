import { ASCIIFont, Box, ImageRenderable, Input, Text, createCliRenderer } from "@opentui/core";

// --- Color palette (Catppuccin Mocha) ---
const colors = {
  bg: "#1e1e2e",
  sidebarBg: "#181825",
  sidebarFg: "#cdd6f4",
  sidebarFgMuted: "#6c7086",
  accent: "#89b4fa",
  accentBg: "#313244",
  border: "#45475a",
  divider: "#313244",
  white: "#cdd6f4",
};

// --- Nerd Font icons (Material Design, nf-md-* — verified against font cmap) ---
const nerd = {
  home: "\u{F02DC}",       // nf-md-home
  star: "\u{F04CE}",       // nf-md-star
  clock: "\u{F0954}",      // nf-md-clock
  trash: "\u{F0A79}",      // nf-md-trash-can
  folder: "\u{F024B}",     // nf-md-folder
  harddisk: "\u{F02CA}",   // nf-md-harddisk
  usb: "\u{F0553}",        // nf-md-usb
  eject: "\u{F01EA}",      // nf-md-eject
  search: "\u{F002}",      // fa-search (heaviest stroke of the plain magnifiers)
};

const sections = [
  {
    items: [
      { icon: nerd.home, label: "Home", ejectable: false },
      { icon: nerd.star, label: "Starred", ejectable: false },
      { icon: nerd.clock, label: "Recent", ejectable: false },
      { icon: nerd.trash, label: "Trash", ejectable: false },
    ],
  },
  {
    items: [
      { icon: nerd.folder, label: "Downloads", ejectable: false },
      { icon: nerd.folder, label: "Documents", ejectable: false },
      { icon: nerd.folder, label: "Pictures", ejectable: false },
      { icon: nerd.folder, label: "Videos", ejectable: false },
      { icon: nerd.folder, label: "Projects", ejectable: false },
      { icon: nerd.folder, label: ".config", ejectable: false },
    ],
  },
  {
    items: [
      { icon: nerd.harddisk, label: "This Device", ejectable: false },
      { icon: nerd.usb, label: "USB Drive", ejectable: true },
      { icon: nerd.usb, label: "SD Card", ejectable: true },
    ],
  },
];

const sw = 26;

const makeRow = (icon: string, label: string, ejectable: boolean, selected: boolean) => {
  const ejectStr = ejectable ? ` ${nerd.eject}` : "";
  const maxLabel = sw - 3 - ejectStr.length;
  const paddedLabel = label.padEnd(Math.max(0, maxLabel)).slice(0, maxLabel);
  const content = ` ${icon} ${paddedLabel}${ejectStr}`;
  return Box(
    { width: sw, height: 1, flexDirection: "row", backgroundColor: selected ? colors.accentBg : "transparent" },
    Text({ content, fg: selected ? colors.accent : colors.sidebarFg }),
  );
};

const makeTitle = () =>
  Box(
    { width: sw, height: 5, flexDirection: "column", justifyContent: "center", paddingLeft: 1 },
    ASCIIFont({ text: "tfm", font: "tiny", color: colors.accent }),
    Text({ content: " terminal file manager", fg: colors.sidebarFgMuted }),
  );

const makeSpacer = () => Box({ width: sw, height: 1 });

const makeDivider = () =>
  Box(
    { width: sw, height: 1 },
    Text({ content: " " + "~".repeat(sw - 2), fg: colors.divider }),
  );

// --- Build sidebar ---
const children: ReturnType<typeof Box>[] = [makeTitle()];

let idx = 0;
for (const section of sections) {
  for (const item of section.items) {
    children.push(makeRow(item.icon, item.label, item.ejectable, idx === 0));
    idx++;
  }
  if (section !== sections[sections.length - 1]) children.push(makeDivider());
}

// --- Toolbar (breadcrumbs derived from cwd) ---
import os from "node:os";
import path from "node:path";

const nav = {
  back: "\u{F0141}",       // nf-md-chevron-left
  fwd: "\u{F0142}",        // nf-md-chevron-right
};

const makeNavButton = (icon: string) =>
  Box(
    { height: 1, width: 3, justifyContent: "center" },
    Text({ content: icon, fg: colors.sidebarFg }),
  );

const makeCrumb = (label: string, icon: string | undefined, current: boolean) =>
  Box(
    { height: 1 },
    Text({ content: icon ? `${icon} ${label}` : label, fg: current ? colors.white : colors.sidebarFgMuted }),
  );

const makeToolbar = (cwd: string) => {
  const home = os.homedir();
  const inHome = cwd === home || cwd.startsWith(home + path.sep);
  const base = inHome
    ? { label: "Home", icon: nerd.home }
    : { label: os.hostname(), icon: "\u{F01C5}" }; // nf-md-desktop-tower
  const rest = path.relative(inHome ? home : path.sep, cwd).split(path.sep).filter(Boolean);
  const crumbs = [base, ...rest.map((label) => ({ label, icon: undefined }))];

  return Box(
    { width: "100%", height: 1, flexDirection: "row", paddingLeft: 1, paddingRight: 1, columnGap: 1 },
    Box(
      { height: 1, flexGrow: 1, flexBasis: 0, overflow: "hidden", flexDirection: "row", columnGap: 1 },
      makeNavButton(nav.back),
      makeNavButton(nav.fwd),
      ...crumbs.flatMap((c, i) =>
        i === 0 ? [makeCrumb(c.label, c.icon, i === crumbs.length - 1)] : [
          Text({ content: " › ", fg: colors.sidebarFgMuted }),
          makeCrumb(c.label, c.icon, i === crumbs.length - 1),
        ]
      ),
    ),
    makeSearch(),
  );
};

let activeRenderer: any = null;

const makeSearch = () => {
  const wrap = Box({ height: 1, flexDirection: "row" });

  const input = Input({
    id: "tfm-search",
    width: 16,
    visible: false,
    placeholder: "Search",
    backgroundColor: colors.accentBg,
    focusedBackgroundColor: colors.accentBg,
    textColor: colors.white,
  });

  const button = Box(
    { id: "tfm-search-btn", height: 1, width: 3, justifyContent: "center", onMouseDown: () => {
      const el: any = activeRenderer?.root.findDescendantById("tfm-search");
      if (!el) return;
      if (el.visible) {
        el.visible = false;
      } else {
        el.visible = true;
        el.focus();
      }
    }},
    Text({ id: "tfm-search-glyph", content: nerd.search, fg: colors.sidebarFg }),
  );

  wrap.add(button);
  wrap.add(input);
  return wrap;
};

// --- Layout ---
const container = Box(
  { width: "100%", height: "100%", flexDirection: "row" },
  Box({ width: sw, height: "100%", backgroundColor: colors.sidebarBg, flexDirection: "column" }, ...children),
  Box(
    { flexGrow: 1, height: "100%", backgroundColor: colors.bg, flexDirection: "column" },
    makeToolbar(process.cwd()),
    Box({ flexGrow: 1 }),
  ),
);

const renderer = await createCliRenderer({ exitOnCtrlC: true });
activeRenderer = renderer;
renderer.root.add(container);

try {
  const btn: any = renderer.root.findDescendantById("tfm-search-btn");
  const img = new ImageRenderable(renderer, {
    id: "tfm-search-img",
    source: `${import.meta.dir}/../assets/icons/search-32-bg.png`,
    width: 2,
    height: 1,
    fit: "fit",
    protocol: "auto",
  });
  // match cell pixel aspect so squares stay square (cells are ~2x taller than wide)
  const aspect = (img as any).cellAspectRatio ?? 2;
  img.width = Math.max(1, Math.round(aspect));
  img.height = 1;
  img.loadPromise!
    .then(() => {
      const glyph = renderer.root.findDescendantById("tfm-search-glyph");
      if (glyph) btn.remove(glyph);
      btn.add(img);
    })
    .catch(() => {});
} catch {}

renderer.keyInput.on("keypress", (e) => {
  const el: any = renderer.root.findDescendantById("tfm-search");
  if (!el?.visible) return;
  if (e.name === "escape" || e.name === "return") {
    el.visible = false;
  }
});
