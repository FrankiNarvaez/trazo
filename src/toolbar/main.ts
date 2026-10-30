import "./toolbar.css";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { t } from "../shared/i18n";
import type { Action } from "../shared/keys";
import { isMac, nativeScale } from "../shared/platform";
import {
  CANVAS_CLOSED,
  CANVAS_COMMAND,
  CANVAS_READY,
  CANVAS_STATUS,
  CANVAS_TOUCHED,
  EXIT_DRAW,
  HISTORY_PUSH,
  PANEL_CLOSE,
  PANEL_DISMISSED,
  PANEL_LABEL,
  PANEL_OPEN,
  PANEL_PICK,
  PANEL_SIZE,
  REQUEST,
  REVEAL,
  TOGGLE_DRAW,
  TOOL_STATE,
  TRAY,
  type CanvasCommand,
  type CanvasStatus,
  type PanelOpen,
} from "../shared/protocol";
import {
  COLORS,
  SHAPES,
  isDrawTool,
  isHexColor,
  isInkTool,
  nextBadgeNumber,
  clampSize,
  presetWidth,
  widthOf,
  SIZE_RANGES,
  type SizeIndex,
  type Tool,
  type ToolState,
} from "../shared/tools";
import {
  centerOf,
  glide,
  listMonitors,
  MARGIN,
  monitorAt,
  placeOnEdge,
  primaryMonitor,
  resolveDock,
  setFrame,
  type Edge,
  type MonitorInfo,
  type Orientation,
  type Rect,
  type Size,
} from "./dock";
import { openMoreMenu } from "./menu";
import { load, save } from "./state";
import { ToolbarView, type PanelTarget } from "./view";

const win = getCurrentWebviewWindow();
const bar = document.getElementById("bar")!;
document.documentElement.classList.toggle("mac", isMac);

const state = load();
let visible = false;
/** Canvas labels in the order they recorded undoable changes (canvases are per monitor). */
const undoStack: string[] = [];
const redoStack: string[] = [];
const strokeCounts = new Map<string, number>();
/** Highest numbered badge on each canvas: numbering runs across every screen. */
const highestNumbers = new Map<string, number>();
/** Canvases with a text box open. Typing isn't a history step yet, so Esc and Undo cancel it. */
const typing = new Set<string>();
/** What the color panel beside the toolbar is editing, while it's open. */
let panel: PanelTarget | null = null;

const view = new ToolbarView(bar, {
  pickTool,
  pickShape: (shape) => setTools({ tool: "shape", shape }),
  pickSwatch,
  editSwatch: (index, opener) => togglePanel({ kind: "swatch", index }, opener),
  pickCustom: (opener) => togglePanel({ kind: "custom" }, opener),
  editTool: (tool, opener) => togglePanel({ kind: "tool", tool }, opener),
  cycleSize: () => pickSize(((state.tools.size + 1) % 3) as SizeIndex),
  undo,
  clear,
  more,
  toggleDraw,
  handleDown: startDrag,
});

function render(): void {
  view.render({
    tools: state.tools,
    lastDrawTool: state.lastDrawTool,
    palette: state.palette,
    customColor: state.customColor,
    panel,
    layout: state.layout,
    canUndo: undoStack.length > 0 || typing.size > 0,
    hasInk: [...strokeCounts.values()].some((n) => n > 0),
  });
}

// ── Tools ────────────────────────────────────────────────────────────────────

function setTools(patch: Partial<ToolState>): void {
  const before = state.tools;
  const next = { ...before, ...patch };
  // Moving on to another tool means you're done choosing a color.
  if (next.tool !== before.tool) closePanel();
  if (isInkTool(next.tool)) state.lastDrawTool = next.tool;
  // Picking a drawing tool brings hidden ink back: drawing blind is never what you want.
  if (isDrawTool(next.tool) && patch.tool) next.inkHidden = false;
  state.tools = next;
  void emit(TOOL_STATE, next);
  if (isDrawTool(next.tool) !== isDrawTool(before.tool)) {
    void invoke("set_drawing", { active: isDrawTool(next.tool) });
  }
  save(state);
  render();
}

/**
 * Thin / medium / thick, from the size button or [ ]. The current tool drops the size set in
 * its settings, so the preset you pick is the one you get.
 */
function pickSize(size: SizeIndex): void {
  const custom = { ...state.tools.custom };
  if (isDrawTool(state.tools.tool)) delete custom[state.tools.tool];
  if (panel?.kind === "tool") closePanel();
  setTools({ size, custom });
}

function pickTool(tool: Tool): void {
  if (tool === "shape" && state.tools.tool === "shape") {
    const i = SHAPES.indexOf(state.tools.shape);
    setTools({ shape: SHAPES[(i + 1) % SHAPES.length] });
  } else {
    setTools({ tool });
  }
}

function pickSwatch(index: number): void {
  closePanel();
  setTools({ color: state.palette[index] });
}

/** Placing, undoing, erasing or clearing a badge on any screen moves the shared count. */
function syncNextNumber(): void {
  const next = nextBadgeNumber(highestNumbers.values());
  if (next !== state.tools.nextNumber) setTools({ nextNumber: next });
}

function toggleDraw(): void {
  setTools({ tool: isDrawTool(state.tools.tool) ? "pointer" : state.lastDrawTool });
}

function apply(action: Action): void {
  switch (action.type) {
    case "tool":
      return setTools(action.shape ? { tool: action.tool, shape: action.shape } : { tool: action.tool });
    case "cycle-shape":
      return pickTool("shape");
    case "color":
      return pickSwatch(action.index);
    case "size":
      return pickSize(Math.min(2, Math.max(0, state.tools.size + action.delta)) as SizeIndex);
    case "undo":
      return undo();
    case "redo":
      return redo();
    case "clear":
      return clear();
    case "exit":
      // Esc closes the color panel or drops the text being typed first; the next one stops
      // drawing. (While drawing, Esc is a global shortcut, so a text box never sees it.)
      if (panel) return closePanel();
      if (typing.size) return cancelText();
      return setTools({ tool: "pointer" });
  }
}

// ── Color panel: a window of its own beside the toolbar (src/panel/) ─────────

function samePanel(a: PanelTarget, b: PanelTarget): boolean {
  if (a.kind === "swatch") return b.kind === "swatch" && a.index === b.index;
  if (a.kind === "tool") return b.kind === "tool" && a.tool === b.tool;
  return b.kind === "custom";
}

/**
 * Opens the panel beside `opener` to edit a swatch or pick any color, or closes it if it's
 * already showing that. What it edits becomes the current color right away.
 */
function togglePanel(target: PanelTarget, opener: HTMLElement): void {
  if (panel && samePanel(panel, target)) return closePanel();
  if (!frame) return;
  const r = opener.getBoundingClientRect();
  const s = nativeScale();
  const placement = {
    anchor: { x: frame.x + r.left * s, y: frame.y + r.top * s, width: r.width * s, height: r.height * s },
    bar: frame,
    orientation: state.layout.orientation,
    hideFromCapture: state.layout.hideFromCapture,
  };
  if (target.kind === "tool") {
    // A tool's settings, beside its button; they don't change the tool or color in use.
    const { tool } = target;
    const [min, max] = SIZE_RANGES[tool];
    panel = target;
    void emitTo<PanelOpen>(PANEL_LABEL, PANEL_OPEN, {
      kind: "tool",
      title: t[tool],
      tool,
      width: widthOf(tool, state.tools),
      preset: presetWidth(tool, state.tools.size),
      min,
      max,
      custom: state.tools.custom[tool] !== undefined,
      color: state.tools.color,
      ...placement,
    });
    return render();
  }
  const color = target.kind === "swatch" ? state.palette[target.index] : (state.customColor ?? state.tools.color);
  panel = target;
  if (target.kind === "custom") state.customColor = color;
  setTools({ color });
  void emitTo<PanelOpen>(PANEL_LABEL, PANEL_OPEN, {
    kind: "color",
    title: target.kind === "swatch" ? `${t.color} ${target.index + 1}` : t.customColor,
    color,
    original: target.kind === "swatch" ? COLORS[target.index] : null,
    ...placement,
  });
}

function closePanel(): void {
  if (!panel) return;
  panel = null;
  void emitTo(PANEL_LABEL, PANEL_CLOSE);
  render();
}

/** Puts the six original colors back; a changed swatch in use gives way to its original. */
function resetPalette(): void {
  const i = state.palette.indexOf(state.tools.color);
  state.palette = [...COLORS];
  closePanel();
  if (i >= 0) {
    setTools({ color: COLORS[i] });
  } else {
    save(state);
    render();
  }
}

// ── History: each step is routed back to the canvas (monitor) that made it ───

function command(label: string | null, cmd: CanvasCommand): void {
  void (label ? emitTo(label, CANVAS_COMMAND, cmd) : emit(CANVAS_COMMAND, cmd));
}

function cancelText(): void {
  command(null, { type: "cancel-text" });
}

function undo(): void {
  if (typing.size) return cancelText();
  const label = undoStack.pop();
  if (!label) return;
  redoStack.push(label);
  command(label, { type: "undo" });
  render();
}

function redo(): void {
  if (typing.size) return; // the text being typed is a new action: nothing is left to redo
  const label = redoStack.pop();
  if (!label) return;
  undoStack.push(label);
  command(label, { type: "redo" });
  render();
}

function clear(): void {
  command(null, { type: "clear" });
}

// ── Placement ────────────────────────────────────────────────────────────────

/** The window's current frame, in native units. */
let frame: Rect | null = null;
let dragging = false;
let layoutQueue = Promise.resolve();

function barSize(): Size {
  const r = bar.getBoundingClientRect();
  const s = nativeScale();
  return { width: Math.ceil(r.width * s), height: Math.ceil(r.height * s) };
}

function firstFrame(monitors: MonitorInfo[], size: Size, margin: number): Rect {
  const { x, y } = state.layout;
  if (x !== null && y !== null) return { x, y, ...size };
  const area = primaryMonitor(monitors).workArea;
  return { x: area.x + area.width - size.width - margin, y: area.y + (area.height - size.height) / 2, ...size };
}

/**
 * Fits the window to the bar and sticks it to its edge. `keep` says which point of the
 * old frame the new one stays on: its top-left (the handle stays under the mouse when
 * collapsing) or its center (a bar that just flipped orientation turns in place).
 */
function relayout(animate: boolean, keep: "start" | "center" = "start"): Promise<void> {
  layoutQueue = layoutQueue
    .then(async () => {
      const monitors = await listMonitors();
      if (monitors.length === 0) return;
      const size = barSize();
      const margin = MARGIN * nativeScale();
      const from = frame ?? firstFrame(monitors, size, margin);
      const c = centerOf(from);
      const anchor = keep === "center" ? { x: c.x - size.width / 2, y: c.y - size.height / 2 } : from;
      const area = monitorAt(monitors, c).workArea;
      const to = placeOnEdge(state.layout.edge, anchor, size, area, margin);
      if (animate && frame) {
        await setFrame({ x: anchor.x, y: anchor.y, ...size });
        await glide({ x: anchor.x, y: anchor.y, ...size }, to);
      } else {
        await setFrame(to);
      }
      frame = to;
      state.layout.x = to.x;
      state.layout.y = to.y;
      save(state);
    })
    .catch((e) => console.error("Trazo: could not place the toolbar", e));
  return layoutQueue;
}

function startDrag(e: PointerEvent): void {
  if (e.button !== 0 || !frame) return;
  const handle = e.currentTarget as HTMLElement;
  handle.setPointerCapture(e.pointerId);
  const s = nativeScale();
  const origin = frame;
  const start = { x: e.screenX, y: e.screenY };
  let moved = false;
  let next: Rect | null = null;
  let raf = 0;

  const move = (ev: PointerEvent) => {
    const dx = (ev.screenX - start.x) * s;
    const dy = (ev.screenY - start.y) * s;
    if (!moved && Math.hypot(dx, dy) < 4 * s) return;
    if (!moved) closePanel();
    moved = dragging = true;
    bar.classList.add("dragging");
    next = { ...origin, x: origin.x + dx, y: origin.y + dy };
    raf ||= requestAnimationFrame(() => {
      raf = 0;
      if (next) {
        frame = next;
        void setFrame(next);
      }
    });
  };

  const up = async () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    if (!moved) return toggleCollapsed();
    cancelAnimationFrame(raf);
    if (next) frame = next;
    dragging = false;
    bar.classList.remove("dragging");

    const dropped = frame!;
    const monitors = await listMonitors();
    const area = monitorAt(monitors, centerOf(dropped)).workArea;
    const dock = resolveDock(dropped, area, state.layout.orientation);
    const flipped = dock.orientation !== state.layout.orientation;
    state.layout.edge = dock.edge;
    state.layout.orientation = dock.orientation;
    render();
    await relayout(true, flipped ? "center" : "start");
  };

  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

function toggleCollapsed(): void {
  closePanel();
  state.layout.collapsed = !state.layout.collapsed;
  save(state);
  render();
}

function setOrientation(orientation: Orientation): void {
  closePanel();
  state.layout.orientation = orientation;
  render();
  void relayout(true, "center");
}

function setEdge(edge: Edge): void {
  closePanel();
  state.layout.edge = edge;
  if (edge === "left" || edge === "right") state.layout.orientation = "vertical";
  if (edge === "top" || edge === "bottom") state.layout.orientation = "horizontal";
  render();
  void relayout(true, "center");
}

async function setVisible(show: boolean): Promise<void> {
  visible = show;
  if (show) {
    await relayout(false);
    await win.show();
  } else {
    // A hidden toolbar can't take you out of drawing mode, so leave it first.
    closePanel();
    if (isDrawTool(state.tools.tool)) setTools({ tool: "pointer" });
    await win.hide();
  }
}

// ── Menus ────────────────────────────────────────────────────────────────────

async function more(): Promise<void> {
  await openMoreMenu({
    layout: state.layout,
    tools: state.tools,
    canRedo: redoStack.length > 0 && typing.size === 0,
    paletteChanged: state.palette.some((c, i) => c !== COLORS[i]),
    setOrientation,
    setEdge,
    redo,
    resetPalette,
    toggleInk: () => setTools({ inkHidden: !state.tools.inkHidden }),
    toggleCapture: () => {
      state.layout.hideFromCapture = !state.layout.hideFromCapture;
      save(state);
      void win.setContentProtected(state.layout.hideFromCapture);
    },
    quit: () => void invoke("quit"),
  });
  void invoke("restore_focus");
}

function onTray(id: string): void {
  switch (id) {
    case "toggle-draw":
      void (visible ? Promise.resolve() : setVisible(true)).then(toggleDraw);
      break;
    case "toggle-toolbar":
      void setVisible(!visible);
      break;
    case "toggle-ink":
      setTools({ inkHidden: !state.tools.inkHidden });
      break;
    case "clear":
      clear();
      break;
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────

// In pointer mode a click on the toolbar shouldn't leave the presentation without focus.
// (Bubbling to the document runs after the button's own handler has updated the state.)
document.addEventListener("click", (e) => {
  if ((e.target as Element).closest(".more")) return; // restores once its menu closes
  if (!isDrawTool(state.tools.tool)) void invoke("restore_focus");
});
document.addEventListener("contextmenu", (e) => e.preventDefault());

void win.listen<string>(CANVAS_READY, ({ payload: label }) => {
  strokeCounts.set(label, strokeCounts.get(label) ?? 0);
  void emitTo(label, TOOL_STATE, state.tools);
});
void win.listen<string>(HISTORY_PUSH, ({ payload: label }) => {
  undoStack.push(label);
  if (redoStack.length) {
    redoStack.length = 0;
    command(null, { type: "drop-redo" });
  }
  render();
});
void win.listen<CanvasStatus>(CANVAS_STATUS, ({ payload }) => {
  strokeCounts.set(payload.label, payload.strokes);
  highestNumbers.set(payload.label, payload.highestNumber);
  if (payload.typing) typing.add(payload.label);
  else typing.delete(payload.label);
  syncNextNumber();
  render();
});
void win.listen<string>(CANVAS_CLOSED, ({ payload: label }) => {
  strokeCounts.delete(label);
  highestNumbers.delete(label);
  typing.delete(label);
  syncNextNumber();
  for (const stack of [undoStack, redoStack]) {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i] === label) stack.splice(i, 1);
  }
  render();
});
void win.listen(CANVAS_TOUCHED, closePanel);
void win.listen<string>(PANEL_PICK, ({ payload: color }) => {
  if (!panel || panel.kind === "tool" || !isHexColor(color)) return;
  if (panel.kind === "swatch") state.palette[panel.index] = color;
  else state.customColor = color;
  setTools({ color });
});
/** A size from a tool's settings, live while dragging; null goes back to the preset. */
void win.listen<number | null>(PANEL_SIZE, ({ payload: size }) => {
  if (panel?.kind !== "tool") return;
  const custom = { ...state.tools.custom };
  if (typeof size === "number" && Number.isFinite(size)) custom[panel.tool] = clampSize(panel.tool, size);
  else delete custom[panel.tool];
  setTools({ custom });
});
void win.listen(PANEL_DISMISSED, () => {
  panel = null;
  render();
});
void win.listen<Action>(REQUEST, ({ payload }) => apply(payload));
void win.listen(TOGGLE_DRAW, () => onTray("toggle-draw"));
void win.listen(EXIT_DRAW, () => apply({ type: "exit" }));
void win.listen<string>(TRAY, ({ payload }) => onTray(payload));
void win.listen(REVEAL, () => setVisible(true));

async function start(): Promise<void> {
  render();
  void emit(TOOL_STATE, state.tools);
  if (state.layout.hideFromCapture) await win.setContentProtected(true);
  await setVisible(true);
  new ResizeObserver(() => {
    if (visible && !dragging) void relayout(false);
  }).observe(bar);
}

void start();

// Browser preview (dev/): lets the harness flip what the native menu would.
if (import.meta.env.DEV) Object.assign(window, { trazo: { setEdge, setOrientation, resetPalette, state } });
