// @effect-diagnostics globalConsole:off - spike script prints progress and its report path.
// @effect-diagnostics globalFetch:off - spike talks to Onshape directly, outside any Effect runtime.
// @effect-diagnostics nodeBuiltinImport:off - spike runs directly in Node.
// @effect-diagnostics globalDate:off - request signing needs the current HTTP date.
// @effect-diagnostics globalTimers:off - polls translations with a plain timer.
/**
 * Spike S5: one full Onshape round trip for a custom feature, by hand.
 *
 * Run: ONSHAPE_CREDENTIAL_FILE=<key.json> node spikes/onshape-roundtrip.ts
 *
 * Writes ONLY to a document this script owns, "cadsense featurescript fixtures", which it creates
 * on first run and remembers in .cadsense/featurescript-spikes/fixture-doc.json. Never touches
 * other documents. Output: .cadsense/featurescript-spikes/s5/{report.json, part-studio.step}.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);
const outDir = NodePath.join(repoRoot, ".cadsense/featurescript-spikes");
const docFile = NodePath.join(outDir, "fixture-doc.json");
const host = "https://cad.onshape.com";
const credentialFile = process.env.ONSHAPE_CREDENTIAL_FILE;
if (!credentialFile) throw new Error("Set ONSHAPE_CREDENTIAL_FILE");
const { accessKeyId, secretKey } = JSON.parse(await NodeFSP.readFile(credentialFile, "utf8")) as {
  accessKeyId: string;
  secretKey: string;
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** Signed Onshape request; same canonical form as apps/server/src/onshape/OnshapeRequestSigner.ts. */
async function onshape(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: JsonObject,
  query = "",
) {
  const nonce = NodeCrypto.randomBytes(18).toString("base64url").slice(0, 25);
  const date = new Date().toUTCString();
  const contentType = "application/json";
  const canonical = [method, nonce, date, contentType, path, query, ""].join("\n").toLowerCase();
  const signature = NodeCrypto.createHmac("sha256", secretKey)
    .update(canonical, "utf8")
    .digest("base64");
  const response = await fetch(`${host}${path}${query ? `?${query}` : ""}`, {
    method,
    redirect: "manual",
    headers: {
      Authorization: `On ${accessKeyId}:HmacSHA256:${signature}`,
      Date: date,
      "On-Nonce": nonce,
      "Content-Type": contentType,
      Accept: "application/json;charset=UTF-8; qs=0.09",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return response;
}
async function json(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: JsonObject,
  query = "",
) {
  const response = await onshape(method, path, body, query);
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as JsonObject) : {};
  if (!response.ok)
    throw Object.assign(new Error(`${method} ${path} -> ${response.status}`), { body: parsed });
  return parsed;
}

/** Collapses Onshape's BTFSValue encoding into plain JSON for the report. */
function fsValue(value: Json): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const type = String(value.btType ?? value.typeTag ?? "");
  const inner = value.value as Json;
  if (type.startsWith("BTFSValueArray")) return (inner as Json[]).map(fsValue);
  if (type.startsWith("BTFSValueMap"))
    return Object.fromEntries(
      (inner as JsonObject[]).map((e) => [
        String(fsValue(e.key as Json)),
        fsValue(e.value as Json),
      ]),
    );
  if (type.startsWith("BTFSValueWithUnits"))
    return { value: inner, units: value.unitToPower ?? null };
  if ("value" in value) return fsValue(inner);
  return value;
}

const report: JsonObject = {};
const step = async <T>(name: string, run: () => Promise<T>) => {
  process.stdout.write(`${name}... `);
  try {
    const result = await run();
    console.log("ok");
    return result;
  } catch (error) {
    console.log("failed");
    report[`${name}:error`] = {
      message: String(error),
      body: (error as { body?: Json }).body ?? null,
    };
    throw error;
  }
};

await NodeFSP.mkdir(NodePath.join(outDir, "s5"), { recursive: true });
try {
  await step("key works", async () => {
    const response = await onshape("GET", "/api/v10/users/sessioninfo");
    if (!response.ok) throw new Error(`sessioninfo ${response.status}`);
  });

  const doc = await step("fixture document", async () => {
    try {
      return JSON.parse(await NodeFSP.readFile(docFile, "utf8")) as { did: string; wid: string };
    } catch {
      const created = await json("POST", "/api/v10/documents", {
        name: "cadsense featurescript fixtures",
        description:
          "Test fixtures written by the cadsense FeatureScript recorder. Safe to delete.",
        isPublic: false,
      });
      const ids = {
        did: String(created.id),
        wid: String((created.defaultWorkspace as JsonObject).id),
      };
      await NodeFSP.writeFile(docFile, JSON.stringify(ids, null, 2));
      return ids;
    }
  });
  report.document = `${host}/documents/${doc.did}/w/${doc.wid}`;
  const w = `d/${doc.did}/w/${doc.wid}`;
  const stamp = new Date().toISOString().slice(0, 19);

  const studio = await step("create feature studio", async () =>
    String(
      (await json("POST", `/api/v10/featurestudios/${w}`, { name: `S5 features ${stamp}` })).id,
    ),
  );
  const version = await step("read current std version", async () => {
    const contents = String(
      (await json("GET", `/api/v10/featurestudios/${w}/e/${studio}`)).contents,
    );
    const match = /FeatureScript\s+(\d+)/.exec(contents);
    if (!match) throw new Error(`no version in default contents: ${contents.slice(0, 120)}`);
    return match[1]!;
  });
  report.stdVersion = version;

  const boltCircle = (
    await NodeFSP.readFile(
      NodePath.join(
        NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
        "../corpus/bolt-circle/feature.fs",
      ),
      "utf8",
    )
  )
    .replace(/FeatureScript \d+;/, `FeatureScript ${version};`)
    .replace(/version : "\d+\.0"/, `version : "${version}.0"`);
  const source = `${boltCircle}
annotation { "Feature Type Name" : "Fixture plate" }
export const fixturePlate = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        fCuboid(context, id + "plate", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(100, 60, 10) * millimeter });
    });
`;
  const upload = await step("upload source", () =>
    json("POST", `/api/v10/featurestudios/${w}/e/${studio}`, { contents: source }),
  );
  report.uploadResponseKeys = Object.keys(upload);
  report.uploadNotices = (upload.notices as Json) ?? "absent";

  const specs = await step("featurespecs", () =>
    json("GET", `/api/v10/featurestudios/${w}/e/${studio}/featurespecs`),
  );
  const featureSpecs = (specs.featureSpecs as JsonObject[]) ?? [];
  report.featureSpecs = featureSpecs.map((spec) => ({
    featureType: spec.featureType ?? null,
    featureTypeName: spec.featureTypeName ?? null,
    sourceMicroversionId: spec.sourceMicroversionId ?? null,
    parameters: ((spec.parameters as JsonObject[]) ?? []).map((p) => ({
      id: p.parameterId ?? null,
      name: p.parameterName ?? null,
      type: p.btType ?? null,
      defaultValue: (p.defaultValue as Json) ?? null,
    })),
  }));
  await NodeFSP.writeFile(
    NodePath.join(outDir, "s5/featurespecs.raw.json"),
    JSON.stringify(specs, null, 2),
  );
  const mv = String(featureSpecs[0]?.sourceMicroversionId ?? "");
  if (!mv) throw new Error("no sourceMicroversionId; the studio probably didn't compile");
  const namespace = `e${studio}::m${mv}`;
  report.namespace = namespace;

  const partStudio = await step("create part studio", async () =>
    String(
      (await json("POST", `/api/v10/partstudios/${w}`, { name: `S5 bolt circle ${stamp}` })).id,
    ),
  );
  const ps = `${w}/e/${partStudio}`;
  const addFeature = (featureType: string, name: string, parameters: JsonObject[]) =>
    json("POST", `/api/v10/partstudios/${ps}/features`, {
      btType: "BTFeatureDefinitionCall-1406",
      feature: {
        btType: "BTMFeature-134",
        featureType,
        name,
        namespace,
        parameters,
        suppressed: false,
        returnAfterSubfeatures: false,
      },
    });
  const evalFs = (script: string) =>
    json("POST", `/api/v10/partstudios/${ps}/featurescript`, { script, queries: [] });

  report.plateFeatureState = (
    await step("insert fixture plate", () => addFeature("fixturePlate", "Fixture plate", []))
  ).featureState as Json;

  const topFace = await step("find top face id", async () => {
    const result = await evalFs(
      "function(context is Context, queries) { return transientQueriesToStrings(evaluateQuery(context, qContainsPoint(qEverything(EntityType.FACE), vector(50, 30, 10) * millimeter))); }",
    );
    const ids = fsValue(result.result as Json) as string[];
    if (ids.length !== 1) throw new Error(`expected one face, got ${JSON.stringify(ids)}`);
    return ids[0]!;
  });
  report.topFaceDeterministicId = topFace;

  const quantity = (parameterId: string, expression: string): JsonObject => ({
    btType: "BTMParameterQuantity-147",
    parameterId,
    expression,
  });
  const bolt = await step("insert bolt circle", () =>
    addFeature("boltCircle", "Bolt circle", [
      {
        btType: "BTMParameterQueryList-148",
        parameterId: "face",
        queries: [{ btType: "BTMIndividualQuery-138", deterministicIds: [topFace] }],
      },
      quantity("count", "6"),
      quantity("circleDiameter", "50 mm"),
      quantity("holeDiameter", "5.5 mm"),
      quantity("startAngle", "30 deg"),
      { btType: "BTMParameterBoolean-144", parameterId: "throughAll", value: true },
    ]),
  );
  report.boltFeatureState = bolt.featureState as Json;
  report.boltFeatureId = (bolt.feature as JsonObject).featureId as Json;
  report.sourceMicroversion = bolt.sourceMicroversion as Json;

  const probe = await step("probe geometry", () =>
    evalFs(`function(context is Context, queries) {
    var out = [];
    for (var body in evaluateQuery(context, qAllSolidBodies()))
    {
        var holes = [];
        for (var face in evaluateQuery(context, qGeometry(qOwnedByBody(body, EntityType.FACE), GeometryType.CYLINDER)))
        {
            const cylinder = evSurfaceDefinition(context, { "face" : face });
            holes = append(holes, [cylinder.coordSystem.origin[0] / millimeter, cylinder.coordSystem.origin[1] / millimeter, cylinder.radius / millimeter]);
        }
        out = append(out, {
            "faces" : size(evaluateQuery(context, qOwnedByBody(body, EntityType.FACE))),
            "edges" : size(evaluateQuery(context, qOwnedByBody(body, EntityType.EDGE))),
            "vertices" : size(evaluateQuery(context, qOwnedByBody(body, EntityType.VERTEX))),
            "volumeMm3" : evVolume(context, { "entities" : body }) / millimeter ^ 3,
            "areaMm2" : evArea(context, { "entities" : qOwnedByBody(body, EntityType.FACE) }) / millimeter ^ 2,
            "holes" : holes
        });
    }
    println("probe ran");
    return out;
}`),
  );
  report.probe = fsValue(probe.result as Json);
  report.probeNotices = (probe.notices as Json) ?? null;
  report.probeConsole = (probe.console as Json) ?? null;

  // Error channels: what Onshape tells us for runtime and parse errors in an evaluated lambda.
  for (const [name, script] of [
    [
      "unknownFunction",
      'function(context is Context, queries) {\n    opThisDoesNotExist(context, newId() + "x", {});\n    return 1;\n}',
    ],
    ["parseError", "function(context is Context, queries) {\n    var x = ;\n    return x;\n}"],
    [
      "thrownRegenError",
      'function(context is Context, queries) {\n    throw regenError("custom failure");\n}',
    ],
  ] as const) {
    const response = await onshape("POST", `/api/v10/partstudios/${ps}/featurescript`, {
      script,
      queries: [],
    });
    const text = await response.text();
    report[`eval:${name}`] = {
      status: response.status,
      body: text ? (JSON.parse(text) as Json) : null,
    };
  }

  // Compile channel: a second studio with a syntax error. Does upload or featurespecs say why?
  const broken = await step("broken studio", async () => {
    const id = String(
      (await json("POST", `/api/v10/featurestudios/${w}`, { name: `S5 broken ${stamp}` })).id,
    );
    const response = await onshape("POST", `/api/v10/featurestudios/${w}/e/${id}`, {
      contents: source.replace('id + "plate",', 'id + "plate"'),
    });
    const uploadBody = (await response.json()) as Json;
    const specsAfter = await json("GET", `/api/v10/featurestudios/${w}/e/${id}/featurespecs`);
    return {
      uploadStatus: response.status,
      uploadBody,
      specCount: ((specsAfter.featureSpecs as Json[]) ?? []).length,
    };
  });
  report.brokenStudio = broken as unknown as Json;

  // STEP export of the part studio, workspace and microversion forms.
  const exportStep = async (revision: string) => {
    const response = await onshape(
      "POST",
      `/api/v10/partstudios/d/${doc.did}/${revision}/e/${partStudio}/translations`,
      {
        formatName: "STEP",
        storeInDocument: false,
        notifyUser: false,
        linkDocumentWorkspaceId: doc.wid,
      } as JsonObject,
    );
    const body = (await response.json()) as JsonObject;
    if (!response.ok) return { accepted: false, status: response.status, body };
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const status = await json("GET", `/api/v10/translations/${String(body.id)}`);
      if (status.requestState === "DONE") {
        const externalId = String((status.resultExternalDataIds as Json[])[0]);
        const download = await onshape(
          "GET",
          `/api/v10/documents/d/${doc.did}/externaldata/${externalId}`,
        );
        const bytes = Buffer.from(await download.arrayBuffer());
        return { accepted: true, seconds: (attempt + 1) * 2, bytes };
      }
      if (status.requestState === "FAILED")
        return { accepted: true, failed: status.failureReason ?? true };
    }
    return { accepted: true, timedOut: true };
  };
  const workspaceStep = await step("STEP export (workspace)", () => exportStep(`w/${doc.wid}`));
  if ("bytes" in workspaceStep && workspaceStep.bytes) {
    await NodeFSP.writeFile(NodePath.join(outDir, "s5/part-studio.step"), workspaceStep.bytes);
    report.stepWorkspace = {
      seconds: workspaceStep.seconds,
      bytes: workspaceStep.bytes.byteLength,
    };
  } else report.stepWorkspace = workspaceStep as unknown as Json;
  const microStep = await step("STEP export (microversion)", () =>
    exportStep(`m/${String(bolt.sourceMicroversion)}`),
  );
  report.stepMicroversion =
    "bytes" in microStep && microStep.bytes
      ? { seconds: microStep.seconds, bytes: microStep.bytes.byteLength }
      : (microStep as unknown as Json);
} finally {
  await NodeFSP.writeFile(NodePath.join(outDir, "s5/report.json"), JSON.stringify(report, null, 2));
  console.log(`report: ${NodePath.join(outDir, "s5/report.json")}`);
}
