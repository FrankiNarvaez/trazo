import {
  ArrowUpRight,
  Circle,
  CircleDot,
  createElement,
  Ellipsis,
  EllipsisVertical,
  Eraser,
  GripHorizontal,
  GripVertical,
  Highlighter,
  MousePointer2,
  PaintBucket,
  Pen,
  Slash,
  Square,
  Trash2,
  Type,
  Undo2,
  type IconNode,
} from "lucide";
import { t } from "../shared/i18n";
import { CLEAR_KEY, SHAPE_KEYS, TOOL_KEYS, UNDO_KEY } from "../shared/keys";
import { COLORS, SHAPES, SIZE_RANGES, TOOLS, isDrawTool, textOn, type DrawTool, type InkTool, type ShapeKind, type Tool, type ToolState } from "../shared/tools";
import type { Layout } from "./state";

/** What the color panel is editing: one of the six swatches, or a color outside the palette. */
export type PanelTarget = { kind: "swatch"; index: number } | { kind: "custom" } | { kind: "tool"; tool: DrawTool };

export interface ViewState {
  tools: ToolState;
  lastDrawTool: InkTool;
  palette: readonly string[];
  customColor: string | null;
  panel: PanelTarget | null;
  layout: Layout;
  canUndo: boolean;
  hasInk: boolean;
}

export interface ViewHandlers {
  pickTool(tool: Tool): void;
  pickShape(shape: ShapeKind): void;
  pickSwatch(index: number): void;
  editSwatch(index: number, opener: HTMLElement): void;
  pickCustom(opener: HTMLElement): void;
  /** Right-click on a tool: open its settings. */
  editTool(tool: DrawTool, opener: HTMLElement): void;
  cycleSize(): void;
  undo(): void;
  clear(): void;
  more(): void;
  toggleDraw(): void;
  handleDown(e: PointerEvent): void;
}

/** The numbers tool has no icon: its button shows the badge the next click will drop. */
const TOOL_ICONS: Record<Exclude<Tool, "shape" | "number">, IconNode> = {
  pointer: MousePointer2,
  pen: Pen,
  highlighter: Highlighter,
  laser: CircleDot,
  text: Type,
  recolor: PaintBucket,
  eraser: Eraser,
};
const SHAPE_ICONS: Record<ShapeKind, IconNode> = {
  arrow: ArrowUpRight,
  rect: Square,
  ellipse: Circle,
  line: Slash,
};
const DOT_SIZES = [4, 7, 11];
/** Tools that use the current color, so they show it under their icon. */
const INKED: ReadonlySet<Tool> = new Set(["pen", "highlighter", "laser", "shape", "text", "recolor"]);
/** What a tool does when its icon alone can't say it. */
const HINTS: Partial<Record<Tool, string>> = { shape: t.shapeHint, text: t.textHint, number: t.numberHint, recolor: t.recolorHint };

const iconFor = (tool: Exclude<Tool, "number">, shape: ShapeKind) =>
  tool === "shape" ? SHAPE_ICONS[shape] : TOOL_ICONS[tool];

function icon(node: IconNode): SVGElement {
  return createElement(node, { "aria-hidden": "true" });
}

function button(className: string, label: string, onClick?: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.title = label;
  b.setAttribute("aria-label", label);
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

function toolLabel(tool: Tool): string {
  const hint = HINTS[tool];
  const settings = isDrawTool(tool) ? ` · ${t.settingsHint}` : "";
  return `${t[tool]} (${TOOL_KEYS[tool]})${hint ? ` · ${hint}` : ""}${settings}`;
}

function shapeLabel(shape: ShapeKind): string {
  const key = SHAPE_KEYS[shape];
  return `${t[shape]}${key ? ` (${key})` : ""}`;
}

/** A swatch keeps its color's name until you change it; then it's just "Color (3)". */
function swatchLabel(palette: readonly string[], i: number): string {
  const name = palette[i] === COLORS[i] ? t.colors[i] : t.color;
  return `${name} (${i + 1}) · ${t.swatchHint}`;
}

/**
 * The toolbar's DOM. Rebuilt only when its structure changes (orientation, collapsed);
 * every other update just patches classes and attributes, so hover states and the
 * drag handle's pointer capture survive.
 */
export class ToolbarView {
  private structure = "";
  private tools = new Map<Tool, HTMLButtonElement>();
  private shapes = new Map<ShapeKind, HTMLButtonElement>();
  private shapeTray?: HTMLElement;
  private swatches: HTMLButtonElement[] = [];
  private custom?: HTMLButtonElement;
  private size?: HTMLButtonElement;
  private undo?: HTMLButtonElement;
  private clear?: HTMLButtonElement;
  private toggle?: HTMLButtonElement;
  private handle?: HTMLButtonElement;
  private icons = new Map<HTMLButtonElement, IconNode>();

  constructor(
    private root: HTMLElement,
    private on: ViewHandlers,
  ) {}

  render(s: ViewState): void {
    const structure = `${s.layout.orientation}:${s.layout.collapsed}`;
    if (structure !== this.structure) {
      this.build(s);
      this.structure = structure;
    }
    this.patch(s);
  }

  private setIcon(b: HTMLButtonElement, node: IconNode): void {
    if (this.icons.get(b) === node) return;
    this.icons.set(b, node);
    b.querySelector("svg, .num")?.remove();
    b.prepend(icon(node));
  }

  private setBadge(b: HTMLButtonElement, n: number): void {
    this.icons.delete(b);
    b.querySelector("svg")?.remove();
    let badge = b.querySelector<HTMLElement>(".num");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "num";
      b.prepend(badge);
    }
    badge.textContent = String(n);
  }

  /** Icon for most tools; the live next-number badge for the numbers tool. */
  private paintTool(b: HTMLButtonElement, tool: Tool, s: ViewState): void {
    if (tool === "number") this.setBadge(b, s.tools.nextNumber);
    else this.setIcon(b, iconFor(tool, s.tools.shape));
  }

  private separator(): HTMLElement {
    const sep = document.createElement("div");
    sep.className = "sep";
    sep.setAttribute("role", "separator");
    return sep;
  }

  private build(s: ViewState): void {
    const { orientation, collapsed } = s.layout;
    const vertical = orientation === "vertical";
    this.root.className = `bar ${orientation}${collapsed ? " collapsed" : ""}`;
    this.root.replaceChildren();
    this.tools.clear();
    this.shapes.clear();
    this.icons.clear();
    this.swatches = [];
    this.shapeTray = this.custom = undefined;

    this.handle = button("handle", collapsed ? t.handleCollapsed : t.handle);
    this.handle.append(icon(vertical ? GripHorizontal : GripVertical));
    this.handle.addEventListener("pointerdown", (e) => this.on.handleDown(e));
    this.root.append(this.handle);

    if (collapsed) {
      this.toggle = button("tool", t.drawToggle, () => this.on.toggleDraw());
      this.root.append(this.toggle);
      return;
    }

    const tools = document.createElement("div");
    tools.className = "group";
    for (const tool of TOOLS) {
      const b = button(tool === "shape" ? "tool variants" : "tool", "", () => this.on.pickTool(tool));
      if (isDrawTool(tool)) this.onRightClick(b, () => this.on.editTool(tool, b));
      this.tools.set(tool, b);
      tools.append(b);
      if (tool === "shape") tools.append(this.buildShapeTray());
    }

    const colors = document.createElement("div");
    colors.className = "colors";
    COLORS.forEach((_, i) => {
      const b = button("swatch", "", () => this.on.pickSwatch(i));
      const edit = (e: Event) => {
        e.preventDefault();
        this.on.editSwatch(i, b);
      };
      b.addEventListener("dblclick", edit);
      b.addEventListener("contextmenu", edit);
      this.swatches.push(b);
      colors.append(b);
    });
    const custom = button("swatch custom", `${t.customColor} · ${t.customHint}`, () => this.on.pickCustom(custom));
    this.custom = custom;
    colors.append(custom);

    this.size = button("size", "", () => this.on.cycleSize());
    this.size.append(document.createElement("span"));

    this.undo = button("", `${t.undo} (${UNDO_KEY})`, () => this.on.undo());
    this.undo.append(icon(Undo2));
    this.clear = button("", `${t.clear} (${CLEAR_KEY})`, () => this.on.clear());
    this.clear.append(icon(Trash2));
    const more = button("more", t.more, () => this.on.more());
    more.append(icon(vertical ? Ellipsis : EllipsisVertical));

    this.root.append(
      tools,
      this.separator(),
      colors,
      this.size,
      this.separator(),
      this.undo,
      this.clear,
      this.separator(),
      more,
    );
  }

  /** The four shapes, shown in place of the Shapes button while that tool is in use. */
  private buildShapeTray(): HTMLElement {
    const tray = document.createElement("div");
    tray.className = "shapes";
    tray.setAttribute("role", "group");
    tray.setAttribute("aria-label", t.shape);
    for (const shape of SHAPES) {
      const b = button("tool", `${shapeLabel(shape)} · ${t.settingsHint}`, () => this.on.pickShape(shape));
      this.onRightClick(b, () => this.on.editTool("shape", b));
      this.setIcon(b, SHAPE_ICONS[shape]);
      this.shapes.set(shape, b);
      tray.append(b);
    }
    this.shapeTray = tray;
    return tray;
  }

  private onRightClick(b: HTMLElement, open: () => void): void {
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      open();
    });
  }

  private patch(s: ViewState): void {
    const { tool, shape, color, size } = s.tools;
    this.root.style.setProperty("--ink", color);
    this.root.style.setProperty("--ink-text", textOn(color));

    if (this.toggle) {
      const shown = tool === "pointer" ? s.lastDrawTool : tool;
      this.paintTool(this.toggle, shown, s);
      this.toggle.classList.toggle("active", tool !== "pointer");
      this.toggle.classList.toggle("inked", INKED.has(shown));
    }

    for (const [name, b] of this.tools) {
      this.paintTool(b, name, s);
      b.classList.toggle("active", name === tool);
      b.classList.toggle("inked", name === tool && INKED.has(name));
      b.title = toolLabel(name);
      b.setAttribute("aria-label", b.title);
      b.setAttribute("aria-pressed", String(name === tool));
    }

    // Shapes unfold into their four variants while the tool is in use, and fold back after.
    const unfolded = tool === "shape";
    const shapesButton = this.tools.get("shape");
    if (shapesButton) shapesButton.hidden = unfolded;
    if (this.shapeTray) this.shapeTray.hidden = !unfolded;
    for (const [name, b] of this.shapes) {
      const current = unfolded && name === shape;
      b.classList.toggle("active", current);
      b.classList.toggle("inked", current);
      b.setAttribute("aria-pressed", String(current));
    }

    this.swatches.forEach((b, i) => {
      const selected = s.palette[i] === color;
      b.style.setProperty("--c", s.palette[i]);
      b.classList.toggle("selected", selected);
      b.title = swatchLabel(s.palette, i);
      b.setAttribute("aria-label", b.title);
      b.setAttribute("aria-pressed", String(selected));
      b.setAttribute("aria-expanded", String(s.panel?.kind === "swatch" && s.panel.index === i));
    });

    // The rainbow swatch remembers the last color picked outside the palette.
    if (this.custom) {
      const selected = s.customColor === color && !s.palette.includes(color);
      if (s.customColor) this.custom.style.setProperty("--c", s.customColor);
      else this.custom.style.removeProperty("--c");
      this.custom.classList.toggle("chosen", s.customColor !== null);
      this.custom.classList.toggle("selected", selected);
      this.custom.setAttribute("aria-pressed", String(selected));
      this.custom.setAttribute("aria-expanded", String(s.panel?.kind === "custom"));
    }

    if (this.size) {
      // A size set in the tool's settings shows as a dot between the smallest and largest.
      const custom = isDrawTool(tool) ? s.tools.custom[tool] : undefined;
      let dot = DOT_SIZES[size];
      if (isDrawTool(tool) && custom !== undefined) {
        const [min, max] = SIZE_RANGES[tool];
        dot = Math.round(DOT_SIZES[0] + ((custom - min) / (max - min)) * (DOT_SIZES[2] - DOT_SIZES[0]));
      }
      this.size.style.setProperty("--d", `${dot}px`);
      this.size.title = `${t.size}: ${custom !== undefined ? `${custom} px` : t.sizes[size]} ([ ])`;
      this.size.setAttribute("aria-label", this.size.title);
    }
    if (this.undo) this.undo.disabled = !s.canUndo;
    if (this.clear) this.clear.disabled = !s.hasInk;
  }
}
