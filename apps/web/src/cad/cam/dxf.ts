// Plate geometry as an R12 DXF in inches, the version every router CAM program reads. Each feature
// type sits on its own layer so the shop can assign operations by layer. Pockets get one layer per
// depth, named in thousandths: POCKET_125 is .125 deep. Islands sit on their pocket's layer.
import type { Vec2 } from "../drawing/analysis";
import type { PlateGeometry } from "./plateGeometry";

const pocketLayer = (depth: number) => `POCKET_${Math.round(depth * 1000)}`;

const n = (value: number) => value.toFixed(5);

export const plateDxf = (plate: PlateGeometry): string => {
  const layers = [
    { name: "OUTLINE", color: 7 },
    { name: "HOLES", color: 4 },
    { name: "CUTOUTS", color: 5 },
    ...[
      ...new Set(
        plate.features.flatMap((f) => (f.kind === "pocket" ? [pocketLayer(f.top - f.floor)] : [])),
      ),
    ].map((name) => ({ name, color: 3 })),
  ];
  const out: string[] = [];
  const pair = (code: number, value: string | number) => out.push(String(code), String(value));
  const polyline = (points: readonly Vec2[], layer: string) => {
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
  pair(70, layers.length);
  for (const layer of layers) {
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
    } else if (feature.kind === "cutout") polyline(feature.polygon, "CUTOUTS");
    else {
      const layer = pocketLayer(feature.top - feature.floor);
      polyline(feature.polygon, layer);
      for (const island of feature.islands) polyline(island, layer);
    }
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
