import {
  angle,
  boolean,
  enumValue,
  integer,
  length,
  list,
  query,
  text,
  type CaseFeature,
  type ConformanceCase,
  type Tolerance,
} from "../Case.ts";

/**
 * Every conformance case. Sources are the `.fs` files next to this one. Values are read in
 * millimeters (or other units that keep numbers near 1), because the default tolerance has an
 * absolute floor of 1e-9.
 */

const corpus = (feature: string, parameters?: CaseFeature["parameters"]): CaseFeature => ({
  source: "corpus.fs",
  feature,
  ...(parameters ? { parameters } : {}),
});

const CORPUS: readonly ConformanceCase[] = [
  {
    name: "corpus-bolt-circle",
    description:
      "Six 5 mm holes on a 50 mm circle, cut through a 100 x 60 x 10 mm plate with std's extrude.",
    covers: "corpus/bolt-circle",
    area: "face/body operations",
    features: [
      corpus("plate"),
      corpus("boltCircle", {
        face: query(
          "qContainsPoint(qCreatedBy(features[0], EntityType.FACE), vector(50, 30, 10) * millimeter)",
        ),
        count: integer(6),
        circleDiameter: length(50),
        holeDiameter: length(5),
        startAngle: angle(0),
        throughAll: boolean(true),
      }),
    ],
  },
  {
    name: "corpus-boss-pattern",
    description:
      "A boss on a plate, copied to four corners with opPattern and merged with opBoolean.",
    covers: "corpus/boss-pattern",
    area: "face/body operations",
    features: [corpus("bossPattern")],
  },
  {
    name: "corpus-chamfered-block",
    description: "A block with its top edges chamfered 2 mm with std's chamfer.",
    covers: "corpus/chamfered-block",
    area: "face/body operations",
    features: [corpus("chamferedBlock")],
  },
  {
    name: "corpus-construction",
    description: "opPlane and opPoint read back with evaluators, and a boss sketched on the plane.",
    covers: "corpus/construction",
    area: "face/body operations",
    features: [corpus("construction")],
  },
  {
    name: "corpus-evaluators",
    description: "Std evaluators on a block and a pin.",
    covers: "corpus/evaluators",
    area: "evaluators/queries",
    features: [corpus("evaluators")],
  },
  {
    name: "corpus-filleted-block",
    description: "A block with its vertical edges filleted at 5 mm with std's fillet.",
    covers: "corpus/filleted-block",
    area: "face/body operations",
    features: [corpus("filletedBlock", { radius: length(5) })],
  },
  {
    name: "corpus-lofted-frustum",
    description: "opLoft between a 20 mm and a 10 mm square sketch region.",
    covers: "corpus/lofted-frustum",
    area: "face/body operations",
    features: [corpus("loftedFrustum")],
  },
  {
    name: "corpus-mass-properties",
    description: "evApproximateMassProperties and evApproximateCentroid on blocks.",
    covers: "corpus/mass-properties",
    area: "evaluators/queries",
    features: [corpus("massProperties")],
  },
  {
    name: "corpus-shelled-box",
    description: "A block shelled 2 mm inward with its top open, with std's shell.",
    covers: "corpus/shelled-box",
    area: "face/body operations",
    features: [corpus("shelledBox")],
  },
  {
    name: "corpus-sphere",
    description: "opSphere, radius 10 mm centered at z = 5 mm.",
    covers: "corpus/sphere",
    area: "face/body operations",
    features: [corpus("sphere")],
  },
  {
    name: "corpus-split-block",
    description: "opSplitPart of a 20 mm cube by the plane z = 5 mm.",
    covers: "corpus/split-block",
    area: "face/body operations",
    features: [corpus("splitBlock")],
  },
  {
    name: "corpus-swept-tube",
    description: "opSweep of a 2 mm circle along a quarter arc.",
    covers: "corpus/swept-tube",
    area: "face/body operations",
    features: [corpus("sweptTube")],
  },
  {
    name: "corpus-thickened-plate",
    description: "opThicken of a 20 mm square region, 3 mm up and 2 mm down.",
    covers: "corpus/thickened-plate",
    area: "face/body operations",
    features: [corpus("thickenedPlate")],
  },
  {
    name: "corpus-turned-shaft",
    description: "A stepped shaft revolved from a sketched profile with std's revolve.",
    covers: "corpus/turned-shaft",
    area: "face/body operations",
    features: [corpus("turnedShaft", { shoulderRadius: length(10) })],
  },
];

const LANGUAGE: readonly ConformanceCase[] = [
  {
    name: "lang-as-precedence",
    description: "`a + b as T` and `a == b as T`.",
    covers: "FeatureScript.md to confirm: `as` precedence relative to arithmetic",
    area: "language",
    features: [{ source: "language.fs", feature: "langAsPrecedence" }],
  },
  {
    name: "lang-nullish-precedence",
    description: "`??` against `||`, `==`, `?:` and `+`.",
    covers: "FeatureScript.md to confirm: `??` precedence relative to `||`",
    area: "language",
    features: [{ source: "language.fs", feature: "langNullishPrecedence" }],
  },
  {
    name: "lang-power",
    description: "`-2^2`, `2^3^2` and friends.",
    covers: "FeatureScript.md to confirm: `^` associativity and unary minus",
    area: "language",
    features: [{ source: "language.fs", feature: "langPower" }],
  },
  {
    name: "lang-tostring",
    description: "toString of maps with mixed keys, of keys(), and of numbers.",
    covers: "FeatureScript.md to confirm: map key order and number formatting in toString",
    area: "language",
    features: [{ source: "language.fs", feature: "langToString" }],
  },
  {
    name: "lang-tilde",
    description: "`~` with units, vectors, nested containers, enums, ids, boxes and planes.",
    covers:
      "FeatureScript.md to confirm: how `~` prints tagged values, numbers and nested containers",
    area: "language",
    features: [{ source: "language.fs", feature: "langTilde" }],
  },
  ...(["array", "args", "enum", "map"] as const).map(
    (kind): ConformanceCase => ({
      name: `lang-trailing-comma-${kind}`,
      description: `A trailing comma in ${kind === "args" ? "an argument list" : kind === "enum" ? "an enum declaration" : `a${kind === "array" ? "n" : ""} ${kind} literal`}.`,
      covers:
        "FeatureScript.md to confirm: trailing commas in arrays, argument lists and enums (and maps)",
      area: "language",
      features: [
        {
          source: `trailing-comma-${kind}.fs`,
          feature: `langTrailingComma${kind === "args" ? "Args" : kind[0]!.toUpperCase() + kind.slice(1)}`,
        },
      ],
    }),
  ),
];

/** `qCreatedBy(features[0] + "<name>", EntityType.<type>)`. */
const created = (name: string, type = "BODY") =>
  `qCreatedBy(features[0] + ${JSON.stringify(name)}, EntityType.${type})`;
const volumesMm3 = (bodies: string) =>
  `mapArray(evaluateQuery(context, ${bodies}), function(body) { return evVolume(context, { "entities" : body }) / millimeter ^ 3; })`;
const pointMm = (point: string) => `vector(${point}) * millimeter`;
/** For each entity `query` finds, the body types of `body`, an expression of `entity`. */
const bodyTypesOf = (query: string, body: string) =>
  `mapArray(evaluateQuery(context, ${query}), function(entity) { return filter([BodyType.SOLID, BodyType.SHEET, BodyType.WIRE, BodyType.POINT], function(bodyType) { return !isQueryEmpty(context, qBodyType(${body}, bodyType)); }); })`;

const CONFIRM: readonly ConformanceCase[] = [
  {
    name: "confirm-evplane-origin",
    description:
      "Where evPlane puts the origin of a block's faces, an L-shaped sketch region and the L's extruded top.",
    covers: "FeatureScript.md to confirm: evPlane puts the plane origin at the face's centroid",
    area: "evaluators/queries",
    features: [{ source: "confirm.fs", feature: "confirmEvPlaneOrigin" }],
    values: {
      blockTopOrigin: `evPlane(context, { "face" : qContainsPoint(${created("block", "FACE")}, ${pointMm("20, 15, 20")}) }).origin / millimeter`,
      blockTopNormal: `evPlane(context, { "face" : qContainsPoint(${created("block", "FACE")}, ${pointMm("20, 15, 20")}) }).normal`,
      blockTopX: `evPlane(context, { "face" : qContainsPoint(${created("block", "FACE")}, ${pointMm("20, 15, 20")}) }).x`,
      blockSideOrigin: `evPlane(context, { "face" : qContainsPoint(${created("block", "FACE")}, ${pointMm("40, 15, 10")}) }).origin / millimeter`,
      sketchRegionOrigin: `evPlane(context, { "face" : qSketchRegion(features[0] + "sketch") }).origin / millimeter`,
      lTopOrigin: `evPlane(context, { "face" : qContainsPoint(${created("lBlock", "FACE")}, ${pointMm("5, 5, 55")}) }).origin / millimeter`,
    },
  },
  {
    name: "confirm-sketch-bodies",
    description:
      "The bodies, edges and vertices a sketch of a rectangle, an open line and a circle makes.",
    covers:
      "FeatureScript.md to confirm: a sketch makes one wire body and one region sheet body; connected lines don't share vertices",
    area: "sketches",
    features: [{ source: "confirm.fs", feature: "confirmSketchBodies" }],
    values: {
      bodies: `size(evaluateQuery(context, ${created("sketch")}))`,
      regions: `size(evaluateQuery(context, qSketchRegion(features[0] + "sketch")))`,
      edges: `size(evaluateQuery(context, ${created("sketch", "EDGE")}))`,
      vertices: `size(evaluateQuery(context, ${created("sketch", "VERTEX")}))`,
      verticesAtRectangleCorner: `size(evaluateQuery(context, qContainsPoint(${created("sketch", "VERTEX")}, ${pointMm("0, 0, 0")})))`,
    },
  },
  {
    name: "confirm-query-order",
    description:
      "The order evaluateQuery returns bodies and faces in, for blocks created out of spatial order.",
    covers: "FeatureScript.md to confirm: query results come back in creation order",
    area: "evaluators/queries",
    features: [{ source: "confirm.fs", feature: "confirmQueryOrder" }],
    values: {
      everythingOrder: volumesMm3("qBodyType(qEverything(EntityType.BODY), BodyType.SOLID)"),
      unionOrder: volumesMm3(
        `qUnion([${created("second")}, ${created("first")}, ${created("third")}])`,
      ),
      faceNormals: `mapArray(evaluateQuery(context, ${created("first", "FACE")}), function(face) { return evPlane(context, { "face" : face }).normal; })`,
      edgeMidpoints: `mapArray(evaluateQuery(context, ${created("first", "EDGE")}), function(edge) { return evEdgeTangentLine(context, { "edge" : edge, "parameter" : 0.5 }).origin / millimeter; })`,
    },
  },
  {
    name: "confirm-through-all",
    description:
      "Extrude through all as a new body (its extent shows in its box) and as a removal.",
    covers:
      'FeatureScript.md to confirm: "Through all" extrudes to a generous model extent rather than exactly through',
    area: "face/body operations",
    features: [
      { source: "confirm.fs", feature: "confirmThroughAllNew" },
      { source: "confirm.fs", feature: "confirmThroughAllRemove" },
    ],
    values: {
      newBodyMinZ: `evBox3d(context, { "topology" : ${created("extrude")} }).minCorner[2] / millimeter`,
      newBodyMaxZ: `evBox3d(context, { "topology" : ${created("extrude")} }).maxCorner[2] / millimeter`,
      removeVolume: `evVolume(context, { "entities" : qCreatedBy(features[1] + "block", EntityType.BODY) }) / millimeter ^ 3`,
    },
  },
  {
    name: "confirm-edge-tangent-parameter",
    description:
      "evEdgeTangentLine along a fit spline through unevenly spaced points, by arc length and by the curve's own parameter.",
    covers: "FeatureScript.md to confirm: edge tangent parameters are uniform over the curve",
    area: "evaluators/queries",
    features: [{ source: "confirm.fs", feature: "confirmFitSpline" }],
    values: {
      byArcLength: `mapArray([0, 0.25, 0.5, 0.75, 1], function(t) { return evEdgeTangentLine(context, { "edge" : ${created("plain", "EDGE")}, "parameter" : t }).origin / millimeter; })`,
      byCurveParameter: `mapArray([0, 0.25, 0.5, 0.75, 1], function(t) { return evEdgeTangentLine(context, { "edge" : ${created("plain", "EDGE")}, "parameter" : t, "arcLengthParameterization" : false }).origin / millimeter; })`,
      directionAtHalf: `evEdgeTangentLine(context, { "edge" : ${created("plain", "EDGE")}, "parameter" : 0.5 }).direction`,
    },
  },
  {
    name: "confirm-fit-spline-spacing",
    description:
      "Length and extent of fit splines through unevenly spaced points, with and without end derivatives.",
    covers: "FeatureScript.md to confirm: opFitSpline spaces points by chord length over [0, 1]",
    area: "holes/helices/curves/surfaces",
    features: [{ source: "confirm.fs", feature: "confirmFitSpline" }],
    values: {
      plainLength: `evLength(context, { "entities" : ${created("plain", "EDGE")} }) / millimeter`,
      derivativesLength: `evLength(context, { "entities" : ${created("derivatives", "EDGE")} }) / millimeter`,
      derivativesMaxY: `evBox3d(context, { "topology" : ${created("derivatives", "EDGE")}, "tight" : true }).maxCorner[1] / millimeter`,
      derivativesMinY: `evBox3d(context, { "topology" : ${created("derivatives", "EDGE")}, "tight" : true }).minCorner[1] / millimeter`,
      derivativesStartDirection: `evEdgeTangentLine(context, { "edge" : ${created("derivatives", "EDGE")}, "parameter" : 0 }).direction`,
    },
  },
  {
    name: "confirm-split-part-id",
    description: "Which piece of a split cube keeps the cube's id.",
    covers: "FeatureScript.md to confirm: opSplitPart leaves the original part id on one piece",
    area: "face/body operations",
    features: [{ source: "confirm.fs", feature: "confirmSplitPartId" }],
    values: {
      createdByCube: volumesMm3(created("cube")),
      createdBySplit: volumesMm3(created("split")),
    },
  },
  {
    name: "confirm-inertia-products",
    description: "The full inertia tensor of an L-shaped part, in kg mm^2.",
    covers: "FeatureScript.md to confirm: products of inertia are -integral(x y)",
    area: "evaluators/queries",
    features: [{ source: "confirm.fs", feature: "confirmInertiaProducts" }],
    values: {
      inertia: `mapArray(evApproximateMassProperties(context, { "entities" : qBodyType(qEverything(EntityType.BODY), BodyType.SOLID), "density" : 1000 * kilogram / meter ^ 3 }).inertia.value, function(row) { return mapArray(row, function(x) { return x * 1e6; }); })`,
      centroid: `evApproximateMassProperties(context, { "entities" : qBodyType(qEverything(EntityType.BODY), BodyType.SOLID), "density" : 1000 * kilogram / meter ^ 3 }).centroid / millimeter`,
      massGrams: `evApproximateMassProperties(context, { "entities" : qBodyType(qEverything(EntityType.BODY), BodyType.SOLID), "density" : 1000 * kilogram / meter ^ 3 }).mass / gram`,
    },
  },
  {
    name: "confirm-plane-and-point",
    description:
      "The size of an opPlane without a size, and whether opPlane and opPoint make construction bodies.",
    covers:
      "FeatureScript.md to confirm: opPlane without a size makes a 1 m plane; opPoint points are construction",
    area: "face/body operations",
    features: [{ source: "confirm.fs", feature: "confirmPlaneAndPoint" }],
    values: {
      planeAreaMm2: `evArea(context, { "entities" : ${created("plane", "FACE")} }) / millimeter ^ 2`,
      planeIsConstruction: `size(evaluateQuery(context, qConstructionFilter(${created("plane")}, ConstructionObject.YES)))`,
      pointIsConstruction: `size(evaluateQuery(context, qConstructionFilter(${created("point")}, ConstructionObject.YES)))`,
      pointBodies: `size(evaluateQuery(context, ${created("point")}))`,
    },
  },
  {
    name: "confirm-contains-point",
    description:
      "qContainsPoint on a 10 mm cube's body and faces, with points inside, on the boundary and outside.",
    covers:
      "FeatureScript.md to confirm: qContainsPoint on solid bodies matches boundary points, not interior ones",
    area: "evaluators/queries",
    features: [{ source: "confirm.fs", feature: "confirmContainsPoint" }],
    values: Object.fromEntries(
      (
        [
          ["bodyInside", "BODY", "5, 5, 5"],
          ["bodyOnFace", "BODY", "5, 5, 10"],
          ["bodyOutside", "BODY", "5, 5, 15"],
          ["facesInside", "FACE", "5, 5, 5"],
          ["facesOnFace", "FACE", "5, 5, 10"],
          ["facesOnEdge", "FACE", "10, 10, 5"],
          ["facesOnCorner", "FACE", "10, 10, 10"],
        ] as const
      ).map(([name, type, point]) => [
        name,
        `size(evaluateQuery(context, qContainsPoint(${created("cube", type)}, ${pointMm(point)})))`,
      ]),
    ),
  },
  {
    name: "confirm-get-property",
    description: "getProperty inside the custom feature that named the body.",
    covers:
      "FeatureScript.md to confirm: getProperty inside a custom feature raises an error rather than returning undefined",
    area: "context/std version",
    features: [{ source: "confirm.fs", feature: "confirmGetProperty" }],
  },
  {
    name: "confirm-transform-wire-point",
    description:
      "Whether a wire body and a mate connector keep their ids through opTransform, and where the connector ends up.",
    covers: "FeatureScript.md to confirm: a wire or point body keeps its id through opTransform",
    area: "face/body operations",
    features: [{ source: "confirm.fs", feature: "confirmTransformWireAndPoint" }],
    values: {
      wireBodies: `size(evaluateQuery(context, ${created("wire")}))`,
      connectorBodies: `size(evaluateQuery(context, ${created("connector")}))`,
      movedWireBodies: `size(evaluateQuery(context, ${created("move")}))`,
      connectorOrigin: `evMateConnector(context, { "mateConnector" : qBodyType(qEverything(EntityType.BODY), BodyType.MATE_CONNECTOR) }).origin / millimeter`,
      wireMinX: `evBox3d(context, { "topology" : qBodyType(qEverything(EntityType.BODY), BodyType.WIRE) }).minCorner[0] / millimeter`,
    },
  },
  {
    name: "confirm-closest-to",
    description:
      "qClosestTo on a 10 mm cube's faces, edges and vertices, with points nearest one, two or three of them.",
    covers:
      "FeatureScript.md to confirm: qClosestTo returns every entity within TOLERANCE.zeroLength of the nearest",
    area: "evaluators/queries",
    features: [{ source: "confirm.fs", feature: "confirmClosestTo" }],
    values: Object.fromEntries(
      (
        [
          ["facesNearOne", "FACE", "15, 5, 5"],
          ["facesNearEdge", "FACE", "15, 15, 5"],
          ["facesNearCorner", "FACE", "15, 15, 15"],
          ["edgesNearEdge", "EDGE", "15, 15, 5"],
          ["edgesNearCorner", "EDGE", "15, 15, 15"],
          ["verticesNearCorner", "VERTEX", "15, 15, 15"],
        ] as const
      ).map(([name, type, point]) => [
        name,
        `size(evaluateQuery(context, qClosestTo(${created("cube", type)}, ${pointMm(point)})))`,
      ]),
    ),
  },
  {
    name: "confirm-align-canonically",
    description:
      "alignCanonically of planes with normals -z, +y, -x, (1, 1, 1) and (0, 1, 3), each given a non-canonical x. Locally alignCanonically knows only the Top, Front and Right planes' axes and stops for these normals, so every value is one the local runtime can't read.",
    covers:
      "Other streams' review: what alignCanonically does for normals other than Top, Front and Right",
    area: "sketches",
    features: [],
    values: Object.fromEntries(
      (
        [
          ["minusZ", "0, 0, -1", "1, 1, 0"],
          ["plusY", "0, 1, 0", "1, 0, 1"],
          ["minusX", "-1, 0, 0", "0, 1, 1"],
          ["tiltedOneOneOne", "1, 1, 1", "1, -1, 0"],
          ["tiltedZeroOneThree", "0, 1, 3", "1, 3, -1"],
        ] as const
      ).map(([name, normal, x]) => [
        name,
        `mapArray([alignCanonically(context, plane(vector(10, 20, 30) * millimeter, normalize(vector(${normal})), normalize(vector(${x}))))], function(p) { return { "origin" : p.origin / millimeter, "normal" : p.normal, "x" : p.x }; })[0]`,
      ]),
    ),
  },
  {
    name: "confirm-sketches-on-faces",
    description:
      "Std newSketch on a block's bottom, back and left faces: the sketch's own plane, its region's evPlane, and where a circle at sketch (5, 5) mm lands. newSketch aligns a face's plane with alignCanonically, which stops locally for these normals, so the case stops locally.",
    covers: "Other streams' review: std newSketch on faces whose normal isn't +z, -y or +x",
    area: "sketches",
    features: [{ source: "confirm.fs", feature: "confirmSketchesOnFaces" }],
    values: Object.fromEntries(
      (["bottom", "back", "left"] as const).flatMap((face) => {
        const sketch = `features[0] + "${face}Sketch"`;
        const plane = (expression: string) =>
          `mapArray([${expression}], function(p) { return { "origin" : p.origin / millimeter, "normal" : p.normal, "x" : p.x }; })[0]`;
        return [
          [
            `${face}SketchPlane`,
            plane(
              `evOwnerSketchPlane(context, { "entity" : qCreatedBy(${sketch}, EntityType.EDGE) })`,
            ),
          ],
          [`${face}RegionPlane`, plane(`evPlane(context, { "face" : qSketchRegion(${sketch}) })`)],
          [
            `${face}CircleCenter`,
            `evCurveDefinition(context, { "edge" : qCreatedBy(${sketch}, EntityType.EDGE) }).coordSystem.origin / millimeter`,
          ],
        ];
      }),
    ),
  },
  {
    name: "confirm-sketch-edges",
    description:
      "Edges and bodies qCreatedBy finds in sketches of a lone circle, a rectangle, and a circle inside a square, with the types of each edge's owner body and of each body; then opSweep of a 1 mm circle along qCreatedBy(sketch, EntityType.EDGE) of a lone 10 mm circle, with its status and volume (197.39 mm^3 for one full turn). Locally every sketch edge comes back twice, once on the wire body and once on the region's sheet (2, 8 and 10 edges), so the opSweep path chains the circle twice and stops at the sharp corner where the two copies meet. Along the wire edge alone it sweeps 197.39 mm^3 locally.",
    covers:
      "Other streams' review: how many edges qCreatedBy finds in a sketch and which bodies own them, and opSweep along them (locally every edge twice: 2, 8 and 10, so opSweep stops)",
    area: "sketches",
    features: [
      { source: "confirm.fs", feature: "confirmSketchEdges" },
      { source: "confirm.fs", feature: "confirmOpSweepAlongSketchCircle" },
    ],
    values: {
      ...Object.fromEntries(
        (["circleSketch", "rectangleSketch", "nestedSketch"] as const).flatMap((sketch) => [
          [`${sketch}Edges`, `size(evaluateQuery(context, ${created(sketch, "EDGE")}))`],
          [`${sketch}EdgeOwnerTypes`, bodyTypesOf(created(sketch, "EDGE"), "qOwnerBody(entity)")],
          [`${sketch}Bodies`, `size(evaluateQuery(context, ${created(sketch)}))`],
          [`${sketch}BodyTypes`, bodyTypesOf(created(sketch), "entity")],
        ]),
      ),
      opSweepVolume: `evVolume(context, { "entities" : qCreatedBy(features[1] + "sweep", EntityType.BODY) }) / millimeter ^ 3`,
    },
  },
  {
    name: "confirm-sweep-along-sketch-circle",
    description:
      "Std sweep of a 1 mm circle along qCreatedBy(sketch, EntityType.EDGE) of a lone 10 mm sketch circle: its status, the path's edge count, and the volume (197.39 mm^3 if it sweeps the full circle once). Locally std sweep stops on LAMINAR_DEPENDENCY, and once that's supported the doubled circle edge is expected to fail it at a sharp corner.",
    covers: "Other streams' review: sweeping along the edges of a sketch circle",
    area: "sketches",
    features: [{ source: "confirm.fs", feature: "confirmSweepAlongSketchCircle" }],
    values: {
      pathEdges: `size(evaluateQuery(context, ${created("path", "EDGE")}))`,
      sweepVolume: `evVolume(context, { "entities" : ${created("sweep")} }) / millimeter ^ 3`,
    },
  },
  {
    name: "context-default-planes",
    description:
      "An empty Part Studio's default planes and origin, and the version the context runs at.",
    covers:
      "Context: Onshape Part Studios start with Origin, Top, Front and Right (std addDefaultFeatures)",
    area: "context/std version",
    features: [],
    values: {
      ...Object.fromEntries(
        (["Top", "Front", "Right"] as const).flatMap((plane) => {
          const face = `qCreatedBy(makeId("${plane}"), EntityType.FACE)`;
          const key = plane.toLowerCase();
          return [
            [`${key}Normal`, `evPlane(context, { "face" : ${face} }).normal`],
            [`${key}X`, `evPlane(context, { "face" : ${face} }).x`],
            [`${key}Origin`, `evPlane(context, { "face" : ${face} }).origin / millimeter`],
            [
              `${key}BoxMin`,
              `evBox3d(context, { "topology" : ${face}, "tight" : true }).minCorner / millimeter`,
            ],
            [
              `${key}BoxMax`,
              `evBox3d(context, { "topology" : ${face}, "tight" : true }).maxCorner / millimeter`,
            ],
            [`${key}AreaMm2`, `evArea(context, { "entities" : ${face} }) / millimeter ^ 2`],
            [
              `${key}Bodies`,
              `size(evaluateQuery(context, qCreatedBy(makeId("${plane}"), EntityType.BODY)))`,
            ],
            [
              `${key}Construction`,
              `size(evaluateQuery(context, qConstructionFilter(qCreatedBy(makeId("${plane}"), EntityType.BODY), ConstructionObject.YES)))`,
            ],
          ];
        }),
      ),
      originBodies: `size(evaluateQuery(context, qCreatedBy(makeId("Origin"), EntityType.BODY)))`,
      originPoint: `evVertexPoint(context, { "vertex" : qCreatedBy(makeId("Origin"), EntityType.VERTEX) }) / millimeter`,
      allBodies: `size(evaluateQuery(context, qEverything(EntityType.BODY)))`,
      contextVersion: "getCurrentVersion(context)",
    },
  },
  ...(["3083", "3095"] as const).map(
    (version): ConformanceCase => ({
      name: `context-large-integer-${version}`,
      description: `Integer literals past 2^53 in a Feature Studio with a ${version} header, and the version its feature runs at.`,
      covers:
        "Context: what V3095_LARGE_INTEGER_LITERALS changed, and which version a feature runs at",
      area: "context/std version",
      features: [{ source: `large-integer-${version}.fs`, feature: `largeInteger${version}` }],
    }),
  ),
];

const waypoint = (point: string | null, x: number, y: number, z: number) => ({
  point: query(point),
  x: length(x),
  y: length(y),
  z: length(z),
});

const WIRE_RUN: readonly ConformanceCase[] = [
  {
    name: "wire-run-free",
    description: "Wire run through three free waypoints: two 12 AWG wires, no port directions.",
    covers: "Wire run (fs-panel-e2e workspace wiring/wire-run.fs)",
    area: "holes/helices/curves/surfaces",
    features: [
      {
        source: "wire-run.fs",
        feature: "wireRun",
        parameters: {
          label: text("Free run"),
          waypoints: list([
            waypoint(null, 0, 0, 0),
            waypoint(null, 50, 20, 10),
            waypoint(null, 100, 0, 30),
          ]),
          startDirection: query(null),
          flipStart: boolean(false),
          endDirection: query(null),
          flipEnd: boolean(false),
          lead: length(15),
          wireCount: integer(2),
          sizeType: enumValue("WireSizeType", "AWG"),
          gauge: integer(12),
          insulation: length(0.6),
          clocking: angle(0),
        },
      },
    ],
  },
  {
    name: "wire-run-ports",
    description:
      "Wire run from a mate connector to a mate connector through a free waypoint: three 2 mm wires, clocked 30 degrees.",
    covers: "Wire run (fs-panel-e2e workspace wiring/wire-run.fs)",
    area: "holes/helices/curves/surfaces",
    features: [
      { source: "wire-ports.fs", feature: "wirePorts" },
      {
        source: "wire-run.fs",
        feature: "wireRun",
        parameters: {
          label: text("Motor to controller"),
          waypoints: list([
            waypoint(`qCreatedBy(features[0] + "motorPort", EntityType.BODY)`, 0, 0, 0),
            waypoint(null, 60, 25, 20),
            waypoint(`qCreatedBy(features[0] + "controllerPort", EntityType.BODY)`, 0, 0, 0),
          ]),
          startDirection: query(null),
          flipStart: boolean(false),
          endDirection: query(null),
          flipEnd: boolean(false),
          lead: length(15),
          wireCount: integer(3),
          sizeType: enumValue("WireSizeType", "DIAMETER"),
          diameter: length(2),
          clocking: angle(30),
        },
      },
    ],
  },
];

const std = (
  name: string,
  feature: string,
  description: string,
  area: ConformanceCase["area"],
  values?: ConformanceCase["values"],
): ConformanceCase => ({
  name,
  description,
  covers: `std feature: ${description.split(":")[0]}`,
  area,
  features: [{ source: "std-features.fs", feature }],
  ...(values ? { values } : {}),
});

const STD: readonly ConformanceCase[] = [
  std(
    "std-extrude",
    "stdExtrude",
    "Extrude: a blind boss added to a block and a blind pocket cut into it.",
    "face/body operations",
  ),
  std(
    "std-revolve",
    "stdRevolve",
    "Revolve: a full revolve (a washer) and a 90 degree revolve.",
    "face/body operations",
  ),
  std(
    "std-fillet",
    "stdFillet",
    "Fillet: the four top edges of a block at 3 mm, with corner blends.",
    "face/body operations",
  ),
  std(
    "std-chamfer",
    "stdChamfer",
    "Chamfer: the top edges of a block, two offsets of 2 and 3 mm.",
    "face/body operations",
  ),
  std(
    "std-shell",
    "stdShell",
    "Shell: a block 1.5 mm inward with two faces removed.",
    "face/body operations",
  ),
  std(
    "std-loft",
    "stdLoft",
    "Loft: std's loft feature from a circle to a square.",
    "face/body operations",
  ),
  std(
    "std-sweep",
    "stdSweep",
    "Sweep: std's sweep feature along a line and a tangent arc.",
    "face/body operations",
    {
      endCapCentroid: `evApproximateCentroid(context, { "entities" : qCapEntity(features[0] + "sweep", CapType.END, EntityType.FACE) }) / millimeter`,
    },
  ),
  std(
    "std-linear-pattern",
    "stdLinearPattern",
    "Linear pattern: a pin as a part, 4 instances 15 mm apart.",
    "face/body operations",
  ),
  std(
    "std-circular-pattern",
    "stdCircularPattern",
    "Circular pattern: a pin as a part, 6 instances about a hub's axis.",
    "face/body operations",
  ),
  std(
    "std-hole",
    "stdHole",
    "Hole: a simple 6 mm through hole at a sketch point.",
    "holes/helices/curves/surfaces",
    {
      // The hole's wall belongs to the block's body; the block itself made only planar faces.
      holeRadius: `evSurfaceDefinition(context, { "face" : qGeometry(qOwnedByBody(${created("block", "BODY")}, EntityType.FACE), GeometryType.CYLINDER) }).radius / millimeter`,
    },
  ),
  std(
    "std-draft",
    "stdDraft",
    "Draft: four side faces 5 degrees about the bottom face.",
    "face/body operations",
  ),
  std(
    "std-helix",
    "stdHelix",
    "Helix: 3 turns on a cylinder's face.",
    "holes/helices/curves/surfaces",
    {
      start: `evEdgeTangentLine(context, { "edge" : ${created("helix", "EDGE")}, "parameter" : 0 }).origin / millimeter`,
      end: `evEdgeTangentLine(context, { "edge" : ${created("helix", "EDGE")}, "parameter" : 1 }).origin / millimeter`,
    },
  ),
  std(
    "std-variable",
    "stdVariable",
    "Variable: #wall = 4 mm, read back for a block's height.",
    "context/std version",
  ),
  std(
    "std-mate-connector",
    "stdMateConnector",
    "Mate connector: on a face centroid, moved and rotated.",
    "evaluators/queries",
    {
      origin: `evMateConnector(context, { "mateConnector" : qBodyType(qEverything(EntityType.BODY), BodyType.MATE_CONNECTOR) }).origin / millimeter`,
      xAxis: `evMateConnector(context, { "mateConnector" : qBodyType(qEverything(EntityType.BODY), BodyType.MATE_CONNECTOR) }).xAxis`,
      zAxis: `evMateConnector(context, { "mateConnector" : qBodyType(qEverything(EntityType.BODY), BodyType.MATE_CONNECTOR) }).zAxis`,
    },
  ),
];

/**
 * The wire edges sketchEntityQuery finds for `entity` in `features[feature] + "sketch"`, each read
 * by `read`, an expression of `edge`.
 */
const sketchEdges = (entity: string, read: string, feature = 0) =>
  `mapArray(evaluateQuery(context, sketchEntityQuery(features[${feature}] + "sketch", EntityType.EDGE, ${JSON.stringify(entity)})), function(edge) { return ${read}; })`;
/** The positions in mm of the vertices sketchEntityQuery finds for `entity`, a sketch point. */
const sketchPoints = (entity: string, feature = 0) =>
  `mapArray(evaluateQuery(context, sketchEntityQuery(features[${feature}] + "sketch", EntityType.VERTEX, ${JSON.stringify(entity)})), function(vertex) { return evVertexPoint(context, { "vertex" : vertex }) / millimeter; })`;
/** An edge's start and end in mm. */
const EDGE_ENDS = `mapArray([0, 1], function(t) { return evEdgeTangentLine(context, { "edge" : edge, "parameter" : t }).origin / millimeter; })`;
/** A circular edge's center and radius in mm. */
const CIRCLE = `{ "center" : evCurveDefinition(context, { "edge" : edge }).coordSystem.origin / millimeter, "radius" : evCurveDefinition(context, { "edge" : edge }).radius / millimeter }`;
/** What every solver case does locally; the report's local column says which. */
const LOCAL_SOLVE =
  "Locally the sketch solver either solves it or, where Onshape's choice isn't known, stops with call.unsupported.";
const SOLVER_COVERS = (question: string) => `Sketch stream's review: ${question}`;
/** Solved positions match within 1e-6 mm: a solver's leftover error near zero isn't a behavior. */
const SOLVED_MM: Tolerance = { relative: 1e-6, absolute: 1e-6 };
const solver = (
  conformanceCase: Omit<ConformanceCase, "area" | "tolerances">,
): ConformanceCase => ({
  ...conformanceCase,
  area: "sketches",
  tolerances: Object.fromEntries(
    Object.keys(conformanceCase.values ?? {}).map((name) => [name, SOLVED_MM]),
  ),
});

const SOLVER: readonly ConformanceCase[] = [
  solver({
    name: "confirm-solver-arc-pulled",
    description: `A FIXed 10 mm arc from 0 to 90 degrees with its end pulled by a COINCIDENT onto a FIXed point at -10 degrees on its circle: the solved arc's center, radius, ends and length (its sweep), or the failure. ${LOCAL_SOLVE}`,
    covers: SOLVER_COVERS("what a FIXed arc does when a COINCIDENT pulls its end along its circle"),
    features: [{ source: "sketch-solver.fs", feature: "solverArcPulled" }],
    values: {
      arc: sketchEdges(
        "arc",
        `{ "circle" : ${CIRCLE}, "ends" : ${EDGE_ENDS}, "length" : evLength(context, { "entities" : edge }) / millimeter }`,
      ),
      target: sketchPoints("target"),
    },
  }),
  solver({
    name: "confirm-solver-inconsistent-parallelogram",
    description: `A parallelogram of four joined lines with both opposite pairs PARALLEL and opposite LENGTHs 10 and 12 mm, which can't all hold: the feature's status and message, and the four lines' ends. ${LOCAL_SOLVE}`,
    covers: SOLVER_COVERS("how the solver reports inconsistent constraints"),
    features: [{ source: "sketch-solver.fs", feature: "solverInconsistentParallelogram" }],
    values: Object.fromEntries(
      [0, 1, 2, 3].map((i) => [`line${i}`, sketchEdges(`line${i}`, EDGE_ENDS)]),
    ),
  }),
  solver({
    name: "confirm-solver-fixed-line-length",
    description: `A FIXed line drawn (0, 0) to (10, 0) mm with a LENGTH of 15 mm: the feature's status and message, and the line's ends. ${LOCAL_SOLVE}`,
    covers: SOLVER_COVERS("a LENGTH on a FIXed line"),
    features: [{ source: "sketch-solver.fs", feature: "solverFixedLineLength" }],
    values: { line: sketchEdges("line", EDGE_ENDS) },
  }),
  solver({
    name: "confirm-solver-distance-side",
    description: `A point drawn on a FIXed line with a DISTANCE of 5 mm to it, once with the line drawn left to right and once right to left: which side the point lands on. ${LOCAL_SOLVE}`,
    covers: SOLVER_COVERS("which side a DISTANCE moves a point that starts on its line"),
    features: [
      { source: "sketch-solver.fs", feature: "solverDistanceLeftToRight" },
      { source: "sketch-solver.fs", feature: "solverDistanceRightToLeft" },
    ],
    values: {
      leftToRightPoint: sketchPoints("point", 0),
      leftToRightLine: sketchEdges("line", EDGE_ENDS, 0),
      rightToLeftPoint: sketchPoints("point", 1),
      rightToLeftLine: sketchEdges("line", EDGE_ENDS, 1),
    },
  }),
  solver({
    name: "confirm-solver-tangent-circle",
    description: `A 5 mm circle drawn at (20, 1) mm across a FIXed line along x, with a RADIUS of 5 mm, TANGENT to the line, and its center COINCIDENT with a FIXed point at (20, -5) mm: the feature's status and the circle's center and radius. ${LOCAL_SOLVE}`,
    covers: SOLVER_COVERS("a TANGENT circle drawn on the other side of its line"),
    features: [{ source: "sketch-solver.fs", feature: "solverTangentCircle" }],
    values: {
      circle: sketchEdges("circle", CIRCLE),
      anchor: sketchPoints("anchor"),
      line: sketchEdges("line", EDGE_ENDS),
    },
  }),
  solver({
    name: "confirm-solver-angle-length",
    description:
      "A free line drawn (0, 0) to (20, 0) mm, its start COINCIDENT with a FIXed line's start and an ANGLE of 70 degrees, then 88 degrees, to it: the free line's solved ends and length, which show whether rotating it keeps the drawn 20 mm. Locally skConstraint does nothing in this branch, so the free line stays along x at 20 mm and the features are OK; the sketch stream's solver grows it to 24.9 mm at 70 degrees.",
    covers: SOLVER_COVERS("whether an ANGLE keeps a free line's drawn length"),
    features: [
      { source: "sketch-solver.fs", feature: "solverAngle70" },
      { source: "sketch-solver.fs", feature: "solverAngle88" },
    ],
    values: Object.fromEntries(
      ([70, 88] as const).map((degrees, feature) => [
        `free${degrees}`,
        sketchEdges(
          "free",
          `{ "ends" : ${EDGE_ENDS}, "length" : evLength(context, { "entities" : edge }) / millimeter }`,
          feature,
        ),
      ]),
    ),
  }),
  solver({
    name: "confirm-solver-level-length",
    description:
      "A free 20 mm line drawn from (0, 10) mm at 30 degrees, joined to nothing, made level three ways: HORIZONTAL, PARALLEL to a FIXed line along x, and an ANGLE of 0 degrees to it. The free line's solved ends and length show whether each keeps 20 mm, which ends move, and whether the three agree. Locally skConstraint does nothing in this branch, so each free line keeps its drawn ends, (0, 10) and (17.32, 20) mm, and the features are OK.",
    covers: SOLVER_COVERS(
      "whether HORIZONTAL, PARALLEL and a zero ANGLE keep a free line's length",
    ),
    features: (["Horizontal", "Parallel", "ZeroAngle"] as const).map((kind) => ({
      source: "sketch-solver.fs",
      feature: `solverLevel${kind}`,
    })),
    values: Object.fromEntries(
      (["horizontal", "parallel", "zeroAngle"] as const).map((kind, feature) => [
        kind,
        sketchEdges(
          "free",
          `{ "ends" : ${EDGE_ENDS}, "length" : evLength(context, { "entities" : edge }) / millimeter }`,
          feature,
        ),
      ]),
    ),
  }),
];

export const CASES: readonly ConformanceCase[] = [
  ...CORPUS,
  ...LANGUAGE,
  ...CONFIRM,
  ...SOLVER,
  ...WIRE_RUN,
  ...STD,
];
