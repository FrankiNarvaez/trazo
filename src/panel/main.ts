import "./panel.css";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createElement, RotateCcw, X, type IconNode } from "lucide";
import { t } from "../shared/i18n";
import { isMac } from "../shared/platform";
import {
  PANEL_CLOSE,
  PANEL_DISMISSED,
  PANEL_OPEN,
  PANEL_PICK,
  PANEL_SIZE,
  TOOLBAR_LABEL,
  type ColorPanelOpen,
  type PanelOpen,
  type ToolPanelOpen,
} from "../shared/protocol";
import { MORE_COLORS } from "../shared/tools";
import { centerOf, listMonitors, monitorAt, placeBeside, setFrame } from "../toolbar/dock";
import { hexToHsv, hsvToHex, type Hsv } from "./hsv";

/** Space between the toolbar and the panel, in CSS pixels. */
const GAP = 8;

const win = getCurrentWebviewWindow();
const root = document.getElementById("panel")!;
document.documentElement.classList.toggle("mac", isMac);

let hsv: Hsv = { h: 0, s: 1, v: 1 };
/** The swatch's original color, for "reset"; null when picking a color outside the palette. */
let original: string | null = null;
let shown = false;
/** Bumped by every open and close, so a slow open can tell it was overtaken. */
let generation = 0;
let contentProtected = false;
/** The tool whose settings are showing, with its preset size for "reset"; null while picking a color. */
let toolSettings: { preset: number; custom: boolean } | null = null;

// ── Building ─────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function button(className: string, label: string, onClick: () => void, node?: IconNode): HTMLButtonElement {
  const b = el("button", className);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  if (node) b.append(createElement(node, { "aria-hidden": "true" }));
  b.addEventListener("click", onClick);
  return b;
}

const title = el("span", "title");
const hex = el("span", "hex");
const reset = button("reset", t.resetColor, onReset, RotateCcw);
const close = button("close", t.close, dismiss, X);
const header = el("header", "");
header.append(title, hex, reset, close);

const shade = el("div", "shade");
const shadeThumb = el("span", "thumb");
shade.append(shadeThumb);
shade.setAttribute("aria-label", t.shade);

const hue = el("div", "hue");
const hueThumb = el("span", "thumb");
hue.append(hueThumb);
hue.setAttribute("aria-label", t.hue);

const presets = el("div", "presets");
const presetButtons = MORE_COLORS.map((color, i) => {
  const b = button("preset", t.moreColors[i], () => choose(color));
  b.style.setProperty("--c", color);
  b.dataset.color = color;
  return b;
});
presets.append(...presetButtons);

// A tool's settings: a free size, from thin to thick.
const slider = el("input", "slider");
slider.type = "range";
slider.step = "1";
slider.setAttribute("aria-label", t.size);
slider.addEventListener("input", () => {
  if (!toolSettings) return;
  toolSettings.custom = true;
  paintSize();
  void emitTo(TOOLBAR_LABEL, PANEL_SIZE, Number(slider.value));
});

root.append(header, shade, hue, presets, slider);

/** Shows the color picker or a tool's settings. */
function showMode(tool: boolean): void {
  shade.hidden = hue.hidden = presets.hidden = tool;
  slider.hidden = !tool;
  reset.title = tool ? t.resetSize : t.resetColor;
  reset.setAttribute("aria-label", reset.title);
}

function paintSize(): void {
  hex.textContent = `${slider.value} px`;
  reset.hidden = false;
  reset.disabled = !toolSettings?.custom;
}

function onReset(): void {
  if (toolSettings) {
    // Back to the preset: the toolbar drops the size set here.
    toolSettings.custom = false;
    slider.value = String(toolSettings.preset);
    paintSize();
    void emitTo(TOOLBAR_LABEL, PANEL_SIZE, null);
  } else if (original) {
    choose(original);
  }
}

// ── Picking ──────────────────────────────────────────────────────────────────

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** HSV for a color. Grays keep the current hue, so the square doesn't jump back to red. */
function fromHex(color: string): Hsv {
  const next = hexToHsv(color);
  return next.s === 0 ? { ...next, h: hsv.h } : next;
}

function paint(): void {
  const color = hsvToHex(hsv);
  root.style.setProperty("--color", color);
  root.style.setProperty("--pure", hsvToHex({ h: hsv.h, s: 1, v: 1 }));
  shadeThumb.style.left = `${hsv.s * 100}%`;
  shadeThumb.style.top = `${(1 - hsv.v) * 100}%`;
  hueThumb.style.left = `${(hsv.h / 360) * 100}%`;
  hex.textContent = color.toUpperCase();
  reset.hidden = original === null;
  reset.disabled = color === original;
  for (const b of presetButtons) b.classList.toggle("selected", b.dataset.color === color);
}

/** Shows `next` and hands it to the toolbar, which applies it live (swatch, cursor, ink). */
function pick(next: Hsv): void {
  const before = hsvToHex(hsv);
  hsv = next;
  paint();
  const color = hsvToHex(hsv);
  if (color !== before) void emitTo(TOOLBAR_LABEL, PANEL_PICK, color);
}

/** A suggested color, or reset: jump straight to it. */
function choose(color: string): void {
  pick(fromHex(color));
}

/** Calls `update` with the pointer's position across `area` (0 to 1 each way) while dragging. */
function draggable(area: HTMLElement, update: (x: number, y: number) => void): void {
  area.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    area.setPointerCapture(e.pointerId);
    const follow = (ev: PointerEvent) => {
      const r = area.getBoundingClientRect();
      update(clamp01((ev.clientX - r.left) / r.width), clamp01((ev.clientY - r.top) / r.height));
    };
    const stop = () => {
      area.removeEventListener("pointermove", follow);
      area.removeEventListener("pointerup", stop);
      area.removeEventListener("pointercancel", stop);
    };
    follow(e);
    area.addEventListener("pointermove", follow);
    area.addEventListener("pointerup", stop);
    area.addEventListener("pointercancel", stop);
  });
}

draggable(shade, (x, y) => pick({ ...hsv, s: x, v: 1 - y }));
draggable(hue, (x) => pick({ ...hsv, h: x * 360 }));

// ── Showing ──────────────────────────────────────────────────────────────────

async function place(p: PanelOpen): Promise<void> {
  const monitors = await listMonitors();
  if (monitors.length === 0) return;
  const monitor = monitorAt(monitors, centerOf(p.bar));
  // Sized for the screen it's going to, which may not be the one it was last on.
  const s = isMac ? 1 : monitor.scale;
  const r = root.getBoundingClientRect();
  const size = { width: Math.ceil(r.width * s), height: Math.ceil(r.height * s) };
  const frame = placeBeside(p.bar, p.anchor, p.orientation, size, monitor.workArea, GAP * s);
  await setFrame(frame);
  // Windows rescales a window that lands on a screen with another scale: size it again.
  if (!isMac) await setFrame(frame);
}

function openColor(p: ColorPanelOpen): void {
  toolSettings = null;
  showMode(false);
  original = p.original;
  hsv = fromHex(p.color);
  paint();
}

function openTool(p: ToolPanelOpen): void {
  toolSettings = { preset: p.preset, custom: p.custom };
  showMode(true);
  root.style.setProperty("--color", p.color);
  slider.min = String(p.min);
  slider.max = String(p.max);
  slider.value = String(p.width);
  paintSize();
}

async function open(p: PanelOpen): Promise<void> {
  const id = ++generation;
  title.textContent = p.title;
  root.setAttribute("aria-label", p.title);
  if (p.kind === "tool") openTool(p);
  else openColor(p);
  if (p.hideFromCapture !== contentProtected) {
    contentProtected = p.hideFromCapture;
    await win.setContentProtected(contentProtected);
  }
  await place(p);
  if (id !== generation || shown) return;
  shown = true;
  await win.show();
}

function hide(): void {
  generation++;
  if (!shown) return;
  shown = false;
  void win.hide();
}

function dismiss(): void {
  hide();
  void emitTo(TOOLBAR_LABEL, PANEL_DISMISSED);
}

// In pointer mode a click here activates Trazo on macOS; hand focus straight back to the
// presentation. (Rust ignores this while drawing, when the canvas keeps the keyboard.)
document.addEventListener("pointerup", () => void invoke("restore_focus"));
document.addEventListener("contextmenu", (e) => e.preventDefault());

void win.listen<PanelOpen>(PANEL_OPEN, ({ payload }) => void open(payload));
void win.listen(PANEL_CLOSE, hide);
