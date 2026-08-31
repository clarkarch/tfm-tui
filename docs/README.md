# tfm website

Single-file static landing page for [tfm](../README.md) — no build step, no dependencies.
The hero is a live HTML mock of the app (sidebar nav, double-click, rubber-band select)
that the 32-theme picker repaints; the real screenshot sits further down.

```bash
cd docs && python3 -m http.server 8080   # preview at http://localhost:8080
```

Deploy: GitHub Pages serves this `/docs` folder from the `dev` branch
(https://clarkarch.github.io/tfm-tui/). Fonts load from Google Fonts with
system mono fallbacks, so the page still works offline.

The theme gallery data is extracted from `src/themes.ts` — regenerate with:

```bash
bun -e 'import {THEME_PRESETS} from "./src/themes.ts"; console.log(JSON.stringify(THEME_PRESETS.map(t=>({name:t.name,bg:t.theme.bg,sidebar:t.theme.sidebarBg,accent:t.theme.accent,green:t.theme.syntaxString,fg:t.theme.white,muted:t.theme.sidebarFgMuted,hover:t.theme.hoverBg}))))'
```
