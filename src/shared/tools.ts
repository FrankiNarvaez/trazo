export type Tool = "pointer" | "pen" | "highlighter" | "laser" | "shape" | "text" | "number" | "recolor" | "eraser";
export type DrawTool = Exclude<Tool, "pointer">;
export type ShapeKind = "arrow" | "rect" | "ellipse" | "line";
export type SizeIndex = 0 | 1 | 2;

export const TOOLS: readonly Tool[] = ["pointer", "pen", "highlighter", "laser", "shape", "text", "number", "recolor", "eraser"];
export const SHAPES: readonly ShapeKind[] = ["arrow", "rect", "ellipse", "line"];
/** The palette's original six colors; each swatch can be changed and keeps its key (1 to 6). */
export const COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#1c1c1e", "#ffffff"] as const;
/** Suggestions in the color panel, chosen to complement the palette: orange, pink, purple, cyan, brown, gray. */
export const MORE_COLORS = ["#ff9500", "#ff2d55", "#af52de", "#5ac8fa", "#a2845e", "#8e8e93"] as const;

export const isHexColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

/**
 * Stroke width in CSS pixels for the thin / medium / thick setting of each tool (badge
 * diameter for numbers, font size for text, brush diameter for the eraser and recolor).
 */
const WIDTHS: Record<DrawTool, readonly [number, number, number]> = {
  pen: [3, 6, 12],
  highlighter: [16, 26, 40],
  laser: [6, 9, 14],
  shape: [3, 5, 9],
  text: [18, 28, 44],
  number: [20, 26, 34],
  recolor: [10, 20, 36],
  eraser: [16, 32, 64],
};

/** The range a tool's settings slider offers for a free size, in the same units as its presets. */
export const SIZE_RANGES: Record<DrawTool, readonly [number, number]> = {
  pen: [1, 40],
  highlighter: [8, 80],
  laser: [3, 30],
  shape: [1, 30],
  text: [10, 120],
  number: [14, 64],
  recolor: [6, 80],
  eraser: [8, 128],
};

/** Sizes set from a tool's settings, used instead of its thin / medium / thick preset. */
export type CustomSizes = Partial<Record<DrawTool, number>>;

/** Everything a canvas needs to know to turn the next gesture into ink. */
export interface ToolState {
  tool: Tool;
  shape: ShapeKind;
  color: string;
  size: SizeIndex;
  inkHidden: boolean;
  custom: CustomSizes;
  /** What the next numbered badge will say. */
  nextNumber: number;
}

export const isDrawTool = (tool: Tool): tool is DrawTool => tool !== "pointer";

/** Tools that put new color on screen; the draw toggle resumes the last one (never an editing tool). */
export type InkTool = Exclude<DrawTool, "eraser" | "recolor">;
export const isInkTool = (tool: Tool): tool is InkTool => isDrawTool(tool) && tool !== "eraser" && tool !== "recolor";

/** The preset size `size` picks for a tool. */
export function presetWidth(tool: Tool, size: SizeIndex): number {
  return WIDTHS[isDrawTool(tool) ? tool : "pen"][size];
}

/** A tool's size: the one set in its settings, or else the current preset. */
export function widthOf(tool: Tool, tools: Pick<ToolState, "size" | "custom">): number {
  return (isDrawTool(tool) ? tools.custom[tool] : undefined) ?? presetWidth(tool, tools.size);
}

/** Clamps `value` into a tool's slider range, in whole pixels. */
export function clampSize(tool: DrawTool, value: number): number {
  const [min, max] = SIZE_RANGES[tool];
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Saved custom sizes, keeping only known tools with a number, clamped into their range. */
export function sanitizeSizes(value: unknown): CustomSizes {
  const out: CustomSizes = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [tool, size] of Object.entries(value)) {
    if (tool in SIZE_RANGES && typeof size === "number" && Number.isFinite(size)) {
      out[tool as DrawTool] = clampSize(tool as DrawTool, size);
    }
  }
  return out;
}

/**
 * The number the next badge gets: one above the highest badge on any screen. Undoing the
 * last badge gives its number back; erasing one in the middle never makes a number repeat.
 */
export function nextBadgeNumber(onScreen: Iterable<number>): number {
  let highest = 0;
  for (const n of onScreen) highest = Math.max(highest, n);
  return highest + 1;
}

/** Near-black or white, whichever reads better on top of `hex` (e.g. a yellow badge). */
export function textOn(hex: string): string {
  const v = parseInt(hex.slice(1), 16);
  const luma = (0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
  return luma > 0.62 ? "#1c1c1e" : "#ffffff";
}
