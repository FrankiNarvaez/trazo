/**
 * Events between the windows. The toolbar owns the state; canvases draw and report back;
 * the color panel only edits the color it was opened for; Rust forwards global hotkeys and
 * tray clicks to the toolbar.
 */
import type { Orientation, Rect } from "../toolbar/dock";
import type { DrawTool } from "./tools";

export const TOOLBAR_LABEL = "toolbar";
export const PANEL_LABEL = "panel";

// Toolbar → canvases
export const TOOL_STATE = "tool-state"; // ToolState, broadcast
export const CANVAS_COMMAND = "canvas-command"; // CanvasCommand, broadcast or to one canvas
export type CanvasCommand =
  | { type: "undo" }
  | { type: "redo" }
  | { type: "clear" }
  | { type: "drop-redo" }
  | { type: "cancel-text" }; // drop the text being typed, as Esc

// Canvases → toolbar
export const CANVAS_READY = "canvas-ready"; // label
export const HISTORY_PUSH = "history-push"; // label: that canvas recorded an undoable change
export const CANVAS_STATUS = "canvas-status"; // CanvasStatus
export const CANVAS_TOUCHED = "canvas-touched"; // label: a gesture started there (closes the color panel)
export const REQUEST = "request"; // Action from a key pressed while the canvas had focus
export interface CanvasStatus {
  label: string;
  strokes: number;
  /** Highest numbered badge on that screen, 0 when there are none. */
  highestNumber: number;
  /** A text box is open there: Esc and Undo cancel it before anything else. */
  typing: boolean;
}

// Toolbar → color panel
export const PANEL_OPEN = "panel-open"; // PanelOpen: show (or retarget) the panel
export const PANEL_CLOSE = "panel-close";
interface PanelPlacement {
  title: string;
  /** The button that opened the panel and the toolbar around it, in native units. */
  anchor: Rect;
  bar: Rect;
  orientation: Orientation;
  hideFromCapture: boolean;
}

/** Picking a color for a swatch, or any color. */
export interface ColorPanelOpen extends PanelPlacement {
  kind: "color";
  color: string;
  /** The swatch's original color, offered as "reset"; null for a color outside the palette. */
  original: string | null;
}

/** A tool's settings: for now, a free size within the tool's range. */
export interface ToolPanelOpen extends PanelPlacement {
  kind: "tool";
  tool: DrawTool;
  width: number;
  /** The size the current thin / medium / thick preset gives, offered as "reset". */
  preset: number;
  min: number;
  max: number;
  /** Whether `width` is a size set here rather than the preset. */
  custom: boolean;
  color: string;
}

export type PanelOpen = ColorPanelOpen | ToolPanelOpen;

// Color panel → toolbar
export const PANEL_PICK = "panel-pick"; // color, live while dragging
export const PANEL_SIZE = "panel-size"; // number, live while dragging; null goes back to the preset
export const PANEL_DISMISSED = "panel-dismissed"; // its close button hid it

// Rust → toolbar
export const TOGGLE_DRAW = "toggle-draw";
export const EXIT_DRAW = "exit-draw";
export const TRAY = "tray"; // menu item id
export const REVEAL = "reveal";
export const CANVAS_CLOSED = "canvas-closed"; // label
