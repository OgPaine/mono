// oled.js
import { FONT } from "./font5x7.js";

const WIDTH = 64, HEIGHT = 32, SAFE = 1;

export const OLED = {
  WIDTH, HEIGHT,

  clear(ctx, invert = false) {
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = invert ? "#fff" : "#000";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  },

  measure(text = "", { bold = false, spacing = FONT.GAP } = {}) {
    text = (text || "").toUpperCase();
    const adv = FONT.W + (bold ? 1 : 0) + spacing;
    return text.length ? text.length * adv - spacing : 0;
  },

  drawChar(ctx, ch, x, y, { bold = false, invert = false } = {}) {
    const g = FONT.MAP[ch] || FONT.MAP[" "];
    const px = (x | 0), py = (y | 0);
    ctx.fillStyle = invert ? "#000" : "#fff";
    for (let r = 0; r < FONT.H; r++) {
      const line = g[r];
      for (let c = 0; c < FONT.W; c++) {
        if (line[c] === "1") {
          ctx.fillRect(px + c, py + r, 1, 1);
          if (bold) ctx.fillRect(px + c + 1, py + r, 1, 1);
        }
      }
    }
    return FONT.W + (bold ? 1 : 0);
  },

  drawText(
    ctx,
    text,
    x,
    y,
    {
      align = "left",
      bold = true,
      invert = false,
      maxWidth = WIDTH,
      spacing = FONT.GAP,
      wrap = false,
      ellipsis = true
    } = {}
  ) {
    text = (text || "").toUpperCase();

    const base = FONT.W + (bold ? 1 : 0);
    const adv = base + spacing;

    // initial x by alignment
    const total = text.length ? text.length * adv - spacing : 0;
    let dx = x | 0;
    if (align === "center") dx = Math.max(SAFE, (x | 0) - (total >> 1));
    if (align === "right")  dx = Math.max(SAFE, (x | 0) - total);

    // single-line fit
    if (!wrap && total > maxWidth - dx) {
      if (ellipsis) {
        const dotsW = 3 * adv - spacing; // "..."
        let cut = text.length;
        while (cut > 0 && (cut * adv - spacing) + dotsW > maxWidth - dx) cut--;
        text = text.slice(0, cut) + "...";
      } else {
        const fit = Math.max(0, Math.floor((maxWidth - dx + spacing) / adv));
        text = text.slice(0, fit);
      }
    }

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = invert ? "#000" : "#fff";

    if (wrap) {
      // word wrap within [dx, maxWidth]
      const words = text.split(/\s+/);
      let cx = dx, cy = y | 0;
      for (const w of words) {
        const ww = w.length ? w.length * adv - spacing : 0;
        if (cx !== dx && cx + ww > maxWidth) {
          cy += FONT.H + 1;
          cx = dx;
          if (cy > HEIGHT - SAFE - FONT.H) break;
        }
        for (const ch of (w + " ")) {
          if (ch === " ") { cx += adv; continue; }
          cx += OLED.drawChar(ctx, ch, cx, cy, { bold, invert });
          cx += spacing;
          if (cx > maxWidth) break;
        }
      }
      return;
    }

    // single-line draw
    let cx = dx;
    for (const ch of text) {
      cx += OLED.drawChar(ctx, ch, cx, y | 0, { bold, invert });
      cx += spacing;
      if (cx > maxWidth) break;
    }
  },

  right(ctx, text, xRight, y, opts = {}) {
    OLED.drawText(ctx, text, xRight, y, { ...opts, align: "right" });
  },

  center(ctx, text, xCenter, y, opts = {}) {
    OLED.drawText(ctx, text, xCenter, y, { ...opts, align: "center" });
  },

  // Layout helper for your 64x32 card
  card(ctx, { L1 = "", L2 = "", L3 = "", L4 = "" }, { invert = false, bold = true } = {}) {
    OLED.clear(ctx, invert);

    const left   = SAFE;
    const right  = WIDTH - SAFE;      // x used as "maxWidth" limit
    const center = WIDTH >> 1;
    const lineH  = FONT.H + 1;

    // Use SAFE top margin to avoid clipping the first row
    const y0 = SAFE;
    const y1 = y0 + lineH;
    const y2 = y0 + lineH;            // center line
    const y3 = HEIGHT - SAFE - FONT.H;

    OLED.drawText(ctx, L1, left,  y0, { align: "left",  bold, invert, maxWidth: right });
    OLED.drawText(ctx, L2, left,  y1, { align: "left",  bold, invert, maxWidth: right });

    // center highlight line
    OLED.center(ctx, L3, center, y2, { bold, invert, maxWidth: right });

    // bottom line left; put numbers on the right if needed
    OLED.drawText(ctx, L4, left,  y3, { align: "left",  bold, invert, maxWidth: right });
  },
};
