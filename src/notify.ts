import { Box, Text } from "@opentui/core";

// --- Toast notifications (top-right, animated slide-in + fade-out). Takes
// the theme colors and a host handle via ctx so it never imports app state. ---

export type NotifyCtx = {
  rootAdd(node: any): void;
  remove(node: any): void;
  byId(id: string): any;
  termW(): number;
  accentBg(): string;
  white(): string;
  sidebarFgMuted(): string;
  // config knob [ui] toast-duration-ms (default 3000)
  durationMs?(): number;
};

type Toast = { id: number; nodeId: string; timer: any };

// shared slide-in animation (also used by the progress toast in index.ts)
export const animateLeft = (node: any, from: number, to: number, ms: number): void => {
  const steps = 8;
  let i = 0;
  const tick = () => {
    i++;
    try {
      node.left = Math.round(from + ((to - from) * i) / steps);
    } catch {}
    if (i < steps) setTimeout(tick, Math.max(16, ms / steps));
  };
  tick();
};

export const makeNotify = (
  ctx: NotifyCtx,
): { notify: (message: string, title?: string) => void; toastCount: () => number } => {
  let toasts: Toast[] = [];
  let toastSeq = 0;

  return {
    toastCount: () => toasts.length,
    notify(message, title = "tfm") {
      // toasts fire from all over (incl. error paths during native memory
      // pressure — see the OOM note in AGENTS.md); a missing toast must never
      // take the app down, so the whole build is guarded
      try {
        const id = ++toastSeq;
        const w = Math.max(24, Math.min(44, message.length + title.length + 6));
        const y = 1 + toasts.length * 4;
        const node: any = Box(
          {
            id: `tfm-toast-${id}`,
            position: "absolute",
            left: ctx.termW() + 2,
            top: y,
            width: w,
            height: 3,
            zIndex: 3500,
            backgroundColor: ctx.accentBg(),
            flexDirection: "column",
            paddingLeft: 1,
          },
          Text({ content: title.slice(0, w - 3), fg: ctx.white() }),
          Text({ content: message.slice(0, w - 3), fg: ctx.sidebarFgMuted() }),
        );
        ctx.rootAdd(node);
        // the proxy is dead weight post-mount — animate/dismiss via the real renderable
        const real: any = ctx.byId(`tfm-toast-${id}`);
        if (!real) return;
        const targetX = Math.max(0, ctx.termW() - w - 2);
        animateLeft(real, ctx.termW() + 2, targetX, 180);
        const entry: Toast = { id, nodeId: `tfm-toast-${id}`, timer: null };
        toasts.push(entry);
        const duration = ctx.durationMs?.() ?? 3000;
        entry.timer = setTimeout(() => {
          let op = 1;
          const fade = () => {
            op -= 0.18;
            try {
              real.opacity = Math.max(0, op);
            } catch {}
            if (op > 0) setTimeout(fade, 24);
            else {
              try {
                ctx.remove(real);
              } catch {}
              toasts = toasts.filter((t) => t.id !== id);
              toasts.forEach((t, i) => {
                const n: any = ctx.byId(t.nodeId);
                try {
                  n.top = 1 + i * 4;
                } catch {}
              });
            }
          };
          fade();
        }, duration);
      } catch {
        // toast allocation failed (memory pressure) — drop it silently
      }
    },
  };
};
