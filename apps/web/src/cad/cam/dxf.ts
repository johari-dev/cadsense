// Plate geometry as an R12 DXF in inches, the version every router CAM program reads. Each feature
// type sits on its own layer so the shop can assign operations by layer.
import type { Vec2 } from "../drawing/analysis";
import type { PlateGeometry } from "./plateGeometry";

const LAYERS = [
  { name: "OUTLINE", color: 7 },
  { name: "HOLES", color: 4 },
  { name: "CUTOUTS", color: 5 },
  { name: "POCKETS", color: 3 },
] as const;
type Layer = (typeof LAYERS)[number]["name"];

const n = (value: number) => value.toFixed(5);

export const plateDxf = (plate: PlateGeometry): string => {
  const out: string[] = [];
  const pair = (code: number, value: string | number) => out.push(String(code), String(value));
  const polyline = (points: readonly Vec2[], layer: Layer) => {
    pair(0, "POLYLINE");
    pair(8, layer);
    pair(66, 1);
    pair(70, 1); // closed
    for (const [x, y] of points) {
      pair(0, "VERTEX");
      pair(8, layer);
      pair(10, n(x));
      pair(20, n(y));
      pair(30, n(0));
    }
    pair(0, "SEQEND");
    pair(8, layer);
  };

  pair(0, "SECTION");
  pair(2, "HEADER");
  pair(9, "$ACADVER");
  pair(1, "AC1009");
  pair(0, "ENDSEC");
  pair(0, "SECTION");
  pair(2, "TABLES");
  pair(0, "TABLE");
  pair(2, "LAYER");
  pair(70, LAYERS.length);
  for (const layer of LAYERS) {
    pair(0, "LAYER");
    pair(2, layer.name);
    pair(70, 0);
    pair(62, layer.color);
    pair(6, "CONTINUOUS");
  }
  pair(0, "ENDTAB");
  pair(0, "ENDSEC");
  pair(0, "SECTION");
  pair(2, "ENTITIES");
  polyline(plate.outline, "OUTLINE");
  for (const feature of plate.features) {
    if (feature.kind === "hole") {
      pair(0, "CIRCLE");
      pair(8, "HOLES");
      pair(10, n(feature.center[0]));
      pair(20, n(feature.center[1]));
      pair(30, n(0));
      pair(40, n(feature.diameter / 2));
    } else polyline(feature.polygon, feature.kind === "cutout" ? "CUTOUTS" : "POCKETS");
  }
  pair(0, "ENDSEC");
  pair(0, "EOF");
  return `${out.join("\n")}\n`;
};

/** Saves text as a file through a temporary link, the way the browser downloads. */
export const downloadText = (name: string, text: string, type = "application/dxf") => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
