import { COLORS, isHexColor, isInkTool, sanitizeSizes, type InkTool, type ToolState } from "../shared/tools";
import type { Edge, Orientation } from "./dock";

export interface Layout {
  orientation: Orientation;
  edge: Edge;
  /** Top-left of the window in native units; null until the toolbar is first placed. */
  x: number | null;
  y: number | null;
  collapsed: boolean;
  hideFromCapture: boolean;
}

export interface Saved {
  tools: ToolState;
  lastDrawTool: InkTool;
  /** The six swatches, as you've left them; keys 1 to 6 pick them. */
  palette: string[];
  /** The last color picked outside the palette, kept in the rainbow swatch. */
  customColor: string | null;
  layout: Layout;
}

const KEY = "trazo:v1";

const defaults = (): Saved => ({
  tools: { tool: "pointer", shape: "arrow", color: COLORS[0], size: 1, inkHidden: false, nextNumber: 1, custom: {} },
  lastDrawTool: "pen",
  palette: [...COLORS],
  customColor: null,
  layout: { orientation: "vertical", edge: "right", x: null, y: null, collapsed: false, hideFromCapture: false },
});

export function load(): Saved {
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Saved>;
    const palette =
      Array.isArray(saved.palette) && saved.palette.length === COLORS.length && saved.palette.every(isHexColor)
        ? saved.palette
        : base.palette;
    const tools = { ...base.tools, ...saved.tools };
    return {
      // Always start in pointer mode with ink visible: never come back covering the screen.
      // Drawings don't survive a restart, so numbering starts over at 1.
      tools: {
        ...tools,
        tool: "pointer",
        color: isHexColor(tools.color) ? tools.color : palette[0],
        inkHidden: false,
        nextNumber: 1,
        custom: sanitizeSizes(tools.custom),
      },
      lastDrawTool: saved.lastDrawTool && isInkTool(saved.lastDrawTool) ? saved.lastDrawTool : base.lastDrawTool,
      palette,
      customColor: isHexColor(saved.customColor) ? saved.customColor : null,
      layout: { ...base.layout, ...saved.layout },
    };
  } catch {
    return base;
  }
}

export function save(state: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private storage can be unavailable; the toolbar still works, it just won't remember.
  }
}
