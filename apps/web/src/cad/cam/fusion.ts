// Sends a plate to Fusion through the CADsense Bridge add-in (integrations/fusion). The add-in
// rebuilds the plate as a solid, sets up the same router operations as the plan, generates them,
// and answers with Fusion's own cycle time. It listens on this computer only, so the browser calls
// it directly: Fusion has to run on the computer showing CADsense, wherever the server is.
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type { PlateGeometry } from "./plateGeometry";
import { BREAKTHROUGH, TAB_SIZE, type CamSettings } from "./toolpaths";

const BRIDGE_URL = "http://127.0.0.1:27190";

const FusionPlateResult = Schema.Struct({
  /** Whether an open document already held this plate and was rebuilt. */
  replaced: Schema.Boolean,
  /** Fusion's machining time for the setup. */
  minutes: Schema.Number,
  operations: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      state: Schema.Literals(["ok", "warning", "error"]),
      message: Schema.optional(Schema.String),
    }),
  ),
});
export type FusionPlateResult = typeof FusionPlateResult.Type;

const decodeResult = Schema.decodeUnknownSync(FusionPlateResult);
const decodeFailure = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }));

export const NOT_RUNNING =
  "Fusion isn't answering. Open Fusion and run the CADsense Bridge add-in from Utilities > Add-Ins.";

/**
 * Builds the plate and its setup in Fusion. `key` names the plate across sends: sending the same
 * key again rebuilds the open document that holds it instead of opening another.
 */
export const sendPlateToFusion = async (job: {
  readonly key: string;
  readonly name: string;
  readonly plate: PlateGeometry;
  readonly settings: CamSettings;
}): Promise<FusionPlateResult> => {
  // A closed local port can hang instead of refusing (WSL, firewalls), and a build can take
  // minutes. A quick health check tells "not running" apart from "still building".
  const alive = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) }).then(
    (health) => health.ok,
    () => false,
  );
  if (!alive) throw new Error(NOT_RUNNING);
  const response = await fetch(`${BRIDGE_URL}/plates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...job, tab: TAB_SIZE, breakthrough: BREAKTHROUGH }),
    // The add-in gives up on generating after five minutes.
    signal: AbortSignal.timeout(6 * 60_000),
  }).catch(() => null);
  if (!response) throw new Error("Fusion stopped answering while it built the plate.");
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      Option.match(decodeFailure(body), {
        onNone: () => `Fusion could not build the plate (HTTP ${response.status}).`,
        onSome: ({ error }) => error,
      }),
    );
  return decodeResult(body);
};
