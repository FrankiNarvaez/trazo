import { widthOf, type ToolState } from "../shared/tools";

function svgCursor(svg: string, size: number, fallback: string): string {
  const hot = Math.round(size / 2);
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hot} ${hot}, ${fallback}`;
}

/** The pen tip: the ink color with a light and a dark ring, so it reads on any background. */
function tip(diameter: number, color: string, opacity: number): string {
  const size = Math.ceil(diameter + 7);
  const c = size / 2;
  const r = diameter / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<circle cx="${c}" cy="${c}" r="${r + 2}" fill="none" stroke="#000" stroke-opacity=".45"/>` +
    `<circle cx="${c}" cy="${c}" r="${r + 1}" fill="none" stroke="#fff" stroke-width="1.2"/>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="${color}" fill-opacity="${opacity}"/>` +
    `</svg>`;
  return svgCursor(svg, size, "crosshair");
}

/** The eraser (white) and recolor (current color) brushes: a ring as wide as what it will touch. */
function ring(diameter: number, color = "#fff"): string {
  const size = Math.ceil(diameter + 4);
  const c = size / 2;
  const r = diameter / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="${color}" fill-opacity=".12" stroke="#000" stroke-opacity=".5" stroke-width="3"/>` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="1.5"/>` +
    `</svg>`;
  return svgCursor(svg, size, "cell");
}

export function cursorFor(tools: ToolState): string {
  const width = widthOf(tools.tool, tools);
  switch (tools.tool) {
    case "pointer":
      return "default";
    case "laser":
      return "none"; // the laser dot is the cursor
    case "shape":
    case "number":
      return "crosshair";
    case "text":
      return "text";
    case "eraser":
      return ring(width);
    case "recolor":
      return ring(width, tools.color);
    case "highlighter":
      return tip(Math.min(width, 32), tools.color, 0.45);
    case "pen":
      return tip(Math.max(4, width), tools.color, 1);
  }
}
