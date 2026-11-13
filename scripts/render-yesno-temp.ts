import { Box, createTextAttributes, Text } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { defaultConfig } from "../src/config/config-schema";
import { makeModalScrim } from "../src/ui/ui-dialogs";

const PANEL_W = 40;

type Concept = {
  body: string;
  warning?: string;
  no: string;
  yes: string;
  focus: "no" | "yes";
};

const normal: Concept = {
  body: "Make tfm the default file manager? Folder opens will use tfm.",
  no: "No",
  yes: "Set as Default",
  focus: "yes",
};

const danger: Concept = {
  body: "Empty the trash? 3 items removed.",
  warning: "This cannot be undone.",
  no: "No",
  yes: "Empty Trash",
  focus: "yes",
};

const concept = process.argv.includes("--normal") ? normal : danger;
const colors = {
  ...defaultConfig.theme,
  bg: "#0a0a0a",
  sidebarBg: "#101018",
  accent: "#7aa2f7",
  accentBg: "#303040",
  divider: "#333344",
  sidebarFg: "#ffffff",
  sidebarFgMuted: "#999999",
  white: "#ffffff",
  ansi1: "#ff6666",
  hoverBg: "#222230",
};

const focusedAttributes = createTextAttributes({ bold: true, underline: true });
const option = (label: string, focused: boolean) =>
  Box(
    { width: "50%", height: 1, flexDirection: "row", justifyContent: "center" },
    Text({
      content: label,
      fg: focused ? (concept.warning ? colors.ansi1 : colors.accent) : colors.white,
      attributes: focused ? focusedAttributes : 0,
    }),
  );

const t = await createTestRenderer({ width: 90, height: 24 });
const panel = makeModalScrim(
  { uiStyle: () => "solid", colors: () => colors },
  {
    id: "tfm-yesno-concept",
    zIndex: 3700,
    panelWidth: PANEL_W,
    onClose: () => {},
  },
  Box(
    { width: "100%", paddingLeft: 2, paddingRight: 2 },
    Text({
      content: concept.body,
      fg: concept.warning ? colors.ansi1 : colors.accent,
      width: PANEL_W - 4,
      wrapMode: "word",
    }),
  ),
  ...(concept.warning
    ? [
        Box({ width: "100%", height: 1 }, Text({ content: "\u00A0", fg: colors.sidebarBg })),
        Box(
          { width: "100%", paddingLeft: 2, paddingRight: 2 },
          Text({
            content: concept.warning,
            fg: colors.ansi1,
            attributes: createTextAttributes({ bold: true }),
            width: PANEL_W - 4,
            wrapMode: "word",
          }),
        ),
      ]
    : []),
  Box({ width: "100%", height: 1 }, Text({ content: "\u00A0", fg: colors.sidebarBg })),
  Box(
    {
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "center",
      columnGap: 2,
    },
    option(concept.no, concept.focus === "no"),
    option(concept.yes, concept.focus === "yes"),
  ),
);

t.renderer.root.add(panel);
await t.renderOnce();
console.log(t.captureCharFrame());
console.log(`\nfocus: ${concept.focus} · ${concept.warning ? "danger red" : "accent blue"} + bold + underline`);
await t.dispose();
