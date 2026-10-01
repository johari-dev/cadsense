// @effect-diagnostics globalConsole:off - spike script prints its measurements.
/**
 * Spike S4: Onshape-style sketch regions from loose sketch curves.
 *
 * Run: node spikes/sketch-regions.ts
 * Splits a large plane face by every sketch edge, then keeps the faces that don't touch the
 * outer boundary. Each case lists the regions Onshape would show and their areas.
 */
import init from "replicad-opencascadejs";

type Oc = Awaited<ReturnType<typeof init>>;
type Shape = InstanceType<Oc["TopoDS_Shape"]>;
type Curve =
  | { kind: "circle"; x: number; y: number; r: number }
  | { kind: "line"; from: [number, number]; to: [number, number] };

const oc = await init();
const BOUND = 1000;

const faces = (shape: Shape) => {
  const out: Shape[] = [];
  for (
    const ex = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE);
    ex.More();
    ex.Next()
  )
    out.push(ex.Current());
  return out;
};
const area = (face: Shape) => {
  const props = new oc.GProp_GProps();
  oc.BRepGProp.SurfaceProperties(face, props, false, false);
  return props.Mass();
};
const touchesBoundary = (face: Shape) => {
  const box = new oc.Bnd_Box();
  oc.BRepBndLib.Add(face, box, false);
  const extent = [box.GetXMin(), box.GetXMax(), box.GetYMin(), box.GetYMax()].map(Math.abs);
  return Math.max(...extent) > BOUND - 1;
};

const edge = (curve: Curve) =>
  curve.kind === "circle"
    ? new oc.BRepBuilderAPI_MakeEdge(
        new oc.gp_Circ(
          new oc.gp_Ax2(new oc.gp_Pnt(curve.x, curve.y, 0), new oc.gp_Dir(0, 0, 1)),
          curve.r,
        ),
      ).Edge()
    : new oc.BRepBuilderAPI_MakeEdge(
        new oc.gp_Pnt(...curve.from, 0),
        new oc.gp_Pnt(...curve.to, 0),
      ).Edge();

const regions = (curves: Curve[]) => {
  const plane = new oc.BRepBuilderAPI_MakeFace(
    new oc.gp_Pln(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(0, 0, 1)),
    -BOUND,
    BOUND,
    -BOUND,
    BOUND,
  ).Face();
  const args = new oc.NCollection_List_TopoDS_Shape();
  args.Append(plane);
  const tools = new oc.NCollection_List_TopoDS_Shape();
  curves.forEach((curve) => tools.Append(edge(curve)));
  const splitter = new oc.BRepAlgoAPI_Splitter();
  splitter.SetArguments(args);
  splitter.SetTools(tools);
  splitter.Build(new oc.Message_ProgressRange());
  if (splitter.HasErrors()) return { error: "splitter failed" };
  return faces(splitter.Shape())
    .filter((face) => !touchesBoundary(face))
    .map((face) => Math.round(area(face) * 1000) / 1000)
    .sort((a, b) => a - b);
};

const rect = (x0: number, y0: number, x1: number, y1: number): Curve[] => [
  { kind: "line", from: [x0, y0], to: [x1, y0] },
  { kind: "line", from: [x1, y0], to: [x1, y1] },
  { kind: "line", from: [x1, y1], to: [x0, y1] },
  { kind: "line", from: [x0, y1], to: [x0, y0] },
];
const disk = (r: number) => Math.round(Math.PI * r * r * 1000) / 1000;

const cases: Array<{ name: string; curves: Curve[]; expect: string }> = [
  {
    name: "six separate circles",
    curves: Array.from({ length: 6 }, (_, i) => ({
      kind: "circle" as const,
      x: 25 * Math.cos(i),
      y: 25 * Math.sin(i),
      r: 2.75,
    })),
    expect: `6 x ${disk(2.75)}`,
  },
  {
    name: "nested circles",
    curves: [
      { kind: "circle", x: 0, y: 0, r: 10 },
      { kind: "circle", x: 0, y: 0, r: 4 },
    ],
    expect: `${disk(4)} and ${Math.round((disk(10) - disk(4)) * 1000) / 1000}`,
  },
  {
    name: "overlapping circles",
    curves: [
      { kind: "circle", x: 0, y: 0, r: 10 },
      { kind: "circle", x: 12, y: 0, r: 10 },
    ],
    expect: "3 regions: lens + 2 equal crescents",
  },
  {
    name: "rectangle with circle inside",
    curves: [...rect(-20, -10, 20, 10), { kind: "circle", x: 0, y: 0, r: 5 }],
    expect: `${disk(5)} and ${800 - disk(5)}`,
  },
  {
    name: "rectangle crossed by circle",
    curves: [...rect(-20, -10, 20, 10), { kind: "circle", x: 20, y: 0, r: 5 }],
    expect: "3 regions",
  },
  {
    name: "open line only",
    curves: [{ kind: "line", from: [0, 0], to: [10, 0] }],
    expect: "0 regions",
  },
];

const t0 = performance.now();
const report = cases.map(({ name, curves, expect }) => ({
  name,
  expect,
  regions: regions(curves),
}));
console.log(JSON.stringify({ totalMs: Math.round(performance.now() - t0), report }, null, 2));
