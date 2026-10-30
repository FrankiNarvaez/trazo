import "./canvas.css";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { actionForKey } from "../shared/keys";
import {
  CANVAS_COMMAND,
  CANVAS_READY,
  CANVAS_STATUS,
  CANVAS_TOUCHED,
  HISTORY_PUSH,
  REQUEST,
  TOOLBAR_LABEL,
  TOOL_STATE,
  type CanvasCommand,
  type CanvasStatus,
} from "../shared/protocol";
import { clampSize, COLORS, nextBadgeNumber, widthOf, type ToolState } from "../shared/tools";
import { cursorFor } from "./cursor";
import { Drawing } from "./history";
import { LaserTrail } from "./laser";
import {
  buildBadge,
  buildInk,
  buildShape,
  buildText,
  drawStroke,
  hits,
  lineHeight,
  measureText,
  textFont,
  textHalo,
  type Point,
  type Sample,
  type Stroke,
  type TextStroke,
} from "./strokes";

const win = getCurrentWebviewWindow();
const label = win.label;

// Two layers: finished ink (repainted only when strokes change) and a live layer for the
// stroke being drawn and the laser, which is cheap to clear every frame.
const inkCanvas = document.getElementById("ink") as HTMLCanvasElement;
const liveCanvas = document.getElementById("live") as HTMLCanvasElement;
const ink = inkCanvas.getContext("2d")!;
const live = liveCanvas.getContext("2d")!;

let tools: ToolState = { tool: "pointer", shape: "arrow", color: COLORS[0], size: 1, inkHidden: false, nextNumber: 1, custom: {} };
const drawing = new Drawing();
const laser = new LaserTrail();

type Gesture =
  | { kind: "ink"; tool: "pen" | "highlighter"; samples: Sample[]; pressure: boolean }
  | { kind: "shape"; from: Point; to: Point; shift: boolean }
  | { kind: "erase"; last: Point; hit: Set<Stroke> }
  | { kind: "recolor"; last: Point; before: Map<Stroke, string> }
  | { kind: "badge"; at: Point }
  | { kind: "place"; at: Point };
let gesture: Gesture | null = null;

const width = () => widthOf(tools.tool, tools);

// ── Painting ─────────────────────────────────────────────────────────────────

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  for (const [canvas, ctx] of [
    [inkCanvas, ink],
    [liveCanvas, live],
  ] as const) {
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  repaint();
  requestFrame();
}

function repaint(skip?: Set<Stroke>): void {
  ink.clearRect(0, 0, innerWidth, innerHeight);
  for (const s of drawing.strokes) if (!skip?.has(s)) drawStroke(ink, s);
}

/** Shift turns lines and arrows to 15° steps, rectangles into squares, ellipses into circles. */
function shapeEnd(g: Extract<Gesture, { kind: "shape" }>): Point {
  if (!g.shift) return g.to;
  const dx = g.to.x - g.from.x;
  const dy = g.to.y - g.from.y;
  if (tools.shape === "rect" || tools.shape === "ellipse") {
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: g.from.x + Math.sign(dx) * d, y: g.from.y + Math.sign(dy) * d };
  }
  const step = Math.PI / 12;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const length = Math.hypot(dx, dy);
  return { x: g.from.x + Math.cos(angle) * length, y: g.from.y + Math.sin(angle) * length };
}

function strokeFor(g: Gesture, done: boolean): Stroke | null {
  if (g.kind === "ink") return buildInk(g.tool, tools.color, width(), g.samples, g.pressure, done);
  if (g.kind === "shape") return buildShape(tools.shape, tools.color, width(), g.from, shapeEnd(g));
  if (g.kind === "badge") return buildBadge(badgeNumber(), tools.color, width(), g.at);
  return null;
}

let frameRequested = false;
function requestFrame(): void {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(paintLive);
}

function paintLive(now: number): void {
  frameRequested = false;
  live.clearRect(0, 0, innerWidth, innerHeight);
  const preview = gesture && strokeFor(gesture, false);
  if (preview) drawStroke(live, preview);
  if (laser.draw(live, tools.color, widthOf("laser", tools), now)) requestFrame();
}

// ── Reporting to the toolbar ─────────────────────────────────────────────────

const numbersOnScreen = () => drawing.strokes.flatMap((s) => (s.kind === "badge" ? [s.number] : []));

/**
 * The toolbar's count runs across every screen; the local check covers a second click
 * landing before the toolbar's update does, so two badges never share a number.
 */
const badgeNumber = () => Math.max(tools.nextNumber, nextBadgeNumber(numbersOnScreen()));

function report(): void {
  void emitTo<CanvasStatus>(TOOLBAR_LABEL, CANVAS_STATUS, {
    label,
    strokes: drawing.strokes.length,
    highestNumber: nextBadgeNumber(numbersOnScreen()) - 1,
    typing: editor !== null,
  });
}

function recorded(): void {
  void emitTo(TOOLBAR_LABEL, HISTORY_PUSH, label);
  report();
}

// ── Text ─────────────────────────────────────────────────────────────────────

/** The open text box, and the text stroke it is editing (null for a new text). */
let editor: {
  box: HTMLTextAreaElement;
  /** The corner you drag to make the text bigger or smaller. */
  handle: HTMLElement;
  at: Point;
  color: string;
  size: number;
  editing: TextStroke | null;
} | null = null;

/** Sizes the box to its text, and keeps the resize corner on its bottom-right. */
function fitEditor(): void {
  if (!editor) return;
  const { box, handle, at, size } = editor;
  const lines = box.value.split("\n").length;
  const w = Math.ceil(measureText(box.value, size) + size); // room for the caret
  const h = lines * lineHeight(size);
  Object.assign(box.style, { font: textFont(size), lineHeight: `${lineHeight(size)}px`, width: `${w}px`, height: `${h}px` });
  handle.style.left = `${at.x + w + 4}px`;
  handle.style.top = `${at.y + h + 4}px`;
}

/**
 * Dragging the corner scales the text from its top-left, like resizing a box. It never takes
 * focus from the text box, so typing carries on after the drag.
 */
function resizeFrom(handle: HTMLElement): void {
  const stop = (e: Event) => e.preventDefault(); // a click elsewhere would blur and save the text
  handle.addEventListener("mousedown", stop);
  handle.addEventListener("pointerdown", (e) => {
    if (!editor || e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const { at, size: from } = editor;
    const reach = (p: Point) => Math.max(1, p.x - at.x + (p.y - at.y));
    const start = reach(pointOf(e));
    const follow = (ev: PointerEvent) => {
      if (!editor) return;
      editor.size = clampSize("text", (from * reach(pointOf(ev))) / start);
      fitEditor();
    };
    const end = () => {
      handle.removeEventListener("pointermove", follow);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      editor?.box.focus();
    };
    handle.addEventListener("pointermove", follow);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
}

/** Gives the box the color and halo the text will be painted with; fitEditor sets its font. */
function styleEditor(): void {
  if (!editor) return;
  const { box, color } = editor;
  Object.assign(box.style, {
    color,
    caretColor: color,
    textShadow: `0 0 2px ${textHalo(color)}, 0 0 2px ${textHalo(color)}`,
  });
  fitEditor();
}

/** Opens a text box at `at`, or over `editing` to change it; the painted copy hides meanwhile. */
function openEditor(at: Point, editing: TextStroke | null): void {
  const box = document.createElement("textarea");
  box.className = "text-editor";
  box.spellcheck = false;
  box.value = editing?.text ?? "";
  box.style.left = `${at.x}px`;
  box.style.top = `${at.y}px`;
  box.addEventListener("input", fitEditor);
  box.addEventListener("keydown", onEditorKey);
  box.addEventListener("blur", () => {
    if (editor?.box === box) closeEditor(true);
  });
  const handle = document.createElement("div");
  handle.className = "text-handle";
  resizeFrom(handle);
  editor = { box, handle, at, color: editing?.color ?? tools.color, size: editing?.width ?? width(), editing };
  document.body.append(box, handle);
  styleEditor();
  if (editing) repaint(new Set([editing]));
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
  report();
}

/** Saves (or, with `save` false, drops) what was typed as one undoable step. */
function closeEditor(save: boolean): void {
  const e = editor;
  if (!e) return;
  editor = null;
  e.box.remove();
  e.handle.remove();
  const text = e.box.value;
  const empty = text.trim() === "";
  const old = e.editing;
  let changed = false;
  if (save && old) {
    const restyled = e.color !== old.color || e.size !== old.width;
    if (empty) changed = drawing.remove([old]);
    else if (text !== old.text || restyled) changed = drawing.replace(old, buildText(text, e.color, e.size, e.at));
  } else if (save && !empty) {
    drawing.add(buildText(text, e.color, e.size, e.at));
    changed = true;
  }
  repaint();
  if (changed) recorded();
  else report();
}

/** Enter saves, ⌘/Ctrl+Enter starts a new line, Esc cancels; other keys type instead of picking tools. */
function onEditorKey(e: KeyboardEvent): void {
  e.stopPropagation();
  if (e.isComposing) return; // Enter that confirms an accent or IME candidate
  if (e.key === "Escape") {
    e.preventDefault();
    closeEditor(false);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) {
      editor?.box.setRangeText("\n", editor.box.selectionStart, editor.box.selectionEnd, "end");
      fitEditor();
    } else {
      closeEditor(true);
    }
  }
}

/** The topmost text under `p`, to edit it instead of starting a new one. */
function textAt(p: Point): TextStroke | null {
  for (let i = drawing.strokes.length - 1; i >= 0; i--) {
    const s = drawing.strokes[i];
    if (s.kind === "text" && hits(s, p, 0)) return s;
  }
  return null;
}

// ── Input ────────────────────────────────────────────────────────────────────

const pointOf = (e: PointerEvent): Point => ({ x: e.clientX, y: e.clientY });
const pressureOf = (e: PointerEvent) => (e.pointerType === "pen" ? e.pressure : 0.5);

/** All the samples the OS delivered since the last event, for smooth fast strokes. */
function samplesOf(e: PointerEvent): PointerEvent[] {
  const list = e.getCoalescedEvents?.();
  return list && list.length > 0 ? list : [e];
}

/** Points every `spacing` px from just past `from` to `to` (just `to` for a click), so fast swipes count. */
function along(from: Point, to: Point, spacing: number): Point[] {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / spacing));
  return Array.from({ length: steps }, (_, i) => ({
    x: from.x + ((to.x - from.x) * (i + 1)) / steps,
    y: from.y + ((to.y - from.y) * (i + 1)) / steps,
  }));
}

/** Marks every stroke the eraser touches between two points, however deep it sits. */
function eraseAlong(g: Extract<Gesture, { kind: "erase" }>, from: Point, to: Point): void {
  const radius = widthOf("eraser", tools) / 2;
  const points = along(from, to, radius / 2);
  let touched = false;
  for (const s of drawing.strokes) {
    if (!g.hit.has(s) && points.some((p) => hits(s, p, radius))) {
      g.hit.add(s);
      touched = true;
    }
  }
  if (touched) repaint(g.hit);
}

/**
 * Paints the strokes the brush passes over with the current color, live. Only the topmost
 * stroke under each point changes: tapping pen ink drawn over a highlight recolors the ink.
 */
function recolorAlong(g: Extract<Gesture, { kind: "recolor" }>, from: Point, to: Point): void {
  const radius = widthOf("recolor", tools) / 2;
  let touched = false;
  for (const p of along(from, to, radius / 2)) {
    for (let i = drawing.strokes.length - 1; i >= 0; i--) {
      const s = drawing.strokes[i];
      if (!hits(s, p, radius)) continue;
      if (s.color !== tools.color) {
        if (!g.before.has(s)) g.before.set(s, s.color);
        s.color = tools.color;
        touched = true;
      }
      break;
    }
  }
  if (touched) repaint();
}

function finish(): void {
  const g = gesture;
  gesture = null;
  if (!g) return;
  if (g.kind === "erase") {
    if (drawing.remove(g.hit)) recorded();
  } else if (g.kind === "recolor") {
    const changes = [...g.before].map(([stroke, from]) => ({ stroke, from, to: stroke.color }));
    if (drawing.recolor(changes)) recorded();
  } else {
    if (g.kind === "place") {
      // Opened on release, once the click's own focus change is over, so the box keeps focus.
      if (tools.tool === "text") {
        const old = textAt(g.at);
        openEditor(old?.at ?? { x: g.at.x, y: g.at.y - lineHeight(width()) / 2 }, old);
      }
      return requestFrame();
    }
    const tooSmall = g.kind === "shape" && Math.hypot(g.to.x - g.from.x, g.to.y - g.from.y) < 3;
    const stroke = strokeFor(g, true);
    if (stroke && !tooSmall) {
      drawing.add(stroke);
      drawStroke(ink, stroke);
      recorded();
    }
  }
  requestFrame();
}

liveCanvas.addEventListener("pointerdown", (e) => {
  // The barrel/back eraser of a stylus erases whatever tool is selected.
  const stylusEraser = e.pointerType === "pen" && (e.button === 5 || (e.buttons & 32) !== 0);
  if (tools.tool === "pointer" || (e.button !== 0 && !stylusEraser)) return;
  if (editor) {
    // A click away from the open text saves it; the next click starts another one.
    closeEditor(true);
    if (tools.tool === "text") return;
  }
  liveCanvas.setPointerCapture(e.pointerId);
  void emitTo(TOOLBAR_LABEL, CANVAS_TOUCHED, label);
  const p = pointOf(e);
  if (stylusEraser || tools.tool === "eraser") {
    gesture = { kind: "erase", last: p, hit: new Set() };
    eraseAlong(gesture, p, p);
  } else if (tools.tool === "recolor") {
    gesture = { kind: "recolor", last: p, before: new Map() };
    recolorAlong(gesture, p, p);
  } else if (tools.tool === "pen" || tools.tool === "highlighter") {
    gesture = { kind: "ink", tool: tools.tool, samples: [[p.x, p.y, pressureOf(e)]], pressure: e.pointerType === "pen" };
  } else if (tools.tool === "shape") {
    gesture = { kind: "shape", from: p, to: p, shift: e.shiftKey };
  } else if (tools.tool === "text") {
    gesture = { kind: "place", at: p };
  } else if (tools.tool === "number") {
    // Follows the pointer until release, so it can be nudged into place.
    gesture = { kind: "badge", at: p };
  }
  requestFrame();
});

liveCanvas.addEventListener("pointermove", (e) => {
  // The laser follows the pointer without clicking: point, don't draw.
  if (tools.tool === "laser") {
    for (const s of samplesOf(e)) laser.add(s.clientX, s.clientY);
    return requestFrame();
  }
  const g = gesture;
  if (!g) return;
  if (g.kind === "ink") {
    for (const s of samplesOf(e)) g.samples.push([s.clientX, s.clientY, pressureOf(s)]);
  } else if (g.kind === "shape") {
    g.to = pointOf(e);
    g.shift = e.shiftKey;
  } else if (g.kind === "badge") {
    g.at = pointOf(e);
  } else if (g.kind !== "place") {
    for (const s of samplesOf(e)) {
      const p = pointOf(s);
      if (g.kind === "erase") eraseAlong(g, g.last, p);
      else recolorAlong(g, g.last, p);
      g.last = p;
    }
  }
  requestFrame();
});

liveCanvas.addEventListener("pointerup", finish);
liveCanvas.addEventListener("pointercancel", finish);
window.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener("keydown", (e) => {
  if (editor) return; // the text box handles its own keys
  if (e.key === "Shift" && gesture?.kind === "shape") {
    gesture.shift = true;
    return requestFrame();
  }
  const action = actionForKey(e);
  if (!action) return;
  e.preventDefault();
  void emitTo(TOOLBAR_LABEL, REQUEST, action);
});

window.addEventListener("keyup", (e) => {
  if (e.key === "Shift" && gesture?.kind === "shape") {
    gesture.shift = false;
    requestFrame();
  }
});

// ── Messages from the toolbar ────────────────────────────────────────────────

void win.listen<ToolState>(TOOL_STATE, ({ payload }) => {
  if (gesture && payload.tool !== tools.tool) finish();
  if (editor && payload.tool !== "text") closeEditor(true);
  // A color or size picked in the toolbar (or the text tool's settings) while typing applies
  // to the text in the box.
  const textSize = widthOf("text", payload);
  if (editor && (payload.color !== tools.color || textSize !== widthOf("text", tools))) {
    if (payload.color !== tools.color) editor.color = payload.color;
    if (textSize !== widthOf("text", tools)) editor.size = textSize;
    styleEditor();
  }
  tools = payload;
  document.body.classList.toggle("ink-hidden", tools.inkHidden);
  document.body.style.cursor = cursorFor(tools);
  requestFrame();
});

void win.listen<CanvasCommand>(CANVAS_COMMAND, ({ payload }) => {
  // Clear keeps the text typed so far, so Undo brings it back with everything else. Any
  // other command drops it: the toolbar cancels an open box before it undoes or redoes.
  if (payload.type === "clear") closeEditor(true);
  else if (payload.type !== "drop-redo") closeEditor(false);
  switch (payload.type) {
    case "undo":
    case "redo":
      if (payload.type === "undo" ? drawing.undo() : drawing.redo()) {
        repaint();
        report();
      }
      break;
    case "clear":
      if (drawing.remove(drawing.strokes)) {
        repaint();
        recorded();
      }
      break;
    case "drop-redo":
      drawing.dropRedo();
      break;
    case "cancel-text":
      break; // closed above
  }
});

window.addEventListener("resize", resize);
resize();
void emitTo(TOOLBAR_LABEL, CANVAS_READY, label);
