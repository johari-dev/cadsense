import { CAD_TOOL_INPUTS, CadViewError, type ThreadId, type TurnId } from "@cadsense/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { CadViewing, type CadAgentTools } from "../cad/CadViewing.ts";

const descriptions = {
  cad_comments_list:
    "List this chat's CAD findings, including reviewed findings, before publishing. Paginate with the returned catalogVersion/cursor. Reuse unchanged findings without reopening them.",
  cad_comment_locate:
    'Pick candidate surface locations from a specific retained capture. Input: {captureId,picks:[{pickKey:"hole-1",intendedOccurrenceId,x:530,y:456}]}. All four pick fields are required. x/y are original-image pixels with top-left origin (1280 by 960), not pixelX/pixelY. Use the occurrence ID from cad_hierarchy. A hit is not semantic verification: an opening may hit an inner wall. Inspect candidates before publishing precise targets; if input is rejected, correct the fields identified in details and retry.',
  cad_comment_inspect:
    "Receive an annotated alternate view of candidate locations. Visually verify each surface and depth. Publish verified screw holes as separate precise comments; do not group them into a whole-part finding because other candidates are occluded. Inspect remaining candidates individually to choose a better angle, or capture a closer alternate view and locate a reliable rim. Render errors require retry, not a claim that precise location is unavailable. Use whole-part fallback only after attempts to locate and verify the specific spot remain uncertain. This does not move the user view.",
  cad_comments_publish: [
    'Publish complete verified findings incrementally. Input: {expectedCatalogVersion,items:[{kind:"new",publicationKey,inspectedSnapshotId,title,body,targets:[{kind:"point",label,candidateId,inspectionId,confirmationReason}]}]}. Each new item requires all six fields shown. Use expectedCatalogVersion from cad_comments_list and inspectedSnapshotId from the inspected cad_capture.snapshotId (or cad_context.state.snapshotId for a whole-part finding).',
    'Precise targets require successful cad_comment_locate then cad_comment_inspect and your visual confirmation of the alternate image. When the precise location cannot be verified, targets may instead contain {kind:"part",label,occurrenceId,preciseLocationLimitation}. The limitation belongs inside each target. Use targets (an array), not target; valid target kinds are point and part, not whole-part. Do not invent coordinates or verification IDs.',
    'To reuse: {expectedCatalogVersion,items:[{kind:"reuse",publicationKey,inspectedSnapshotId,reuseCommentId}]}. A new finding may also include link:{kind:"correction"|"follow-up",commentId,explanation} for materially new evidence. Published content and review state cannot be edited by the agent.',
    "Check every result: tool completion does not mean publication succeeded. For invalid-input, correct the fields identified in details and retry; failed items did not publish. Retry identical successful requests with stable publicationKey values. Empty holes alone do not prove screws are required: describe the evidence and uncertainty accurately.",
  ].join(" "),
  cad_context: "Read your private CAD view revision, state, and locally available scene roots.",
  cad_measure:
    'Read bounded measurements at {expectedRevision,snapshotId}. For points use {mode:"point-distance",from:{space:"world",point:[x,y,z]},to:{space:"part",occurrenceId,point:[x,y,z]}}. Coordinates are meters in original assembled Z-up world or part CAD coordinates before the occurrence transform. Points are caller-specified and unverified; never copy exploded display coordinates. For approximate unsigned triangle-surface separation use {mode:"surface-clearance",fromOccurrenceId,toOccurrenceId}, with part occurrence IDs from cad_hierarchy. Geometry uses original assembled placements regardless of visibility or explosion. Check status: unknown has no measurement. Positive surface distance does not exclude solid containment, and zero does not prove penetration. Results provide mesh provenance and uncertainty, not manufacturing tolerance.',
  cad_hierarchy:
    "Read a bounded page of the selected CAD component tree with occurrence visibility.",
  cad_update_view: [
    'Atomically update your private CAD view at expectedRevision. operations is an ordered array of tagged objects: {type:"select-root",rootId}, {type:"camera-preset",preset}, {type:"camera-pose",pose}, {type:"fit",occurrenceIds:[]}, {type:"show"|"hide"|"isolate",occurrenceIds:[id]}, {type:"reset-visibility"}, or {type:"explode",amount:0..1}.',
    'You can use arbitrary camera angles and origins beyond the toolbar presets. camera-pose accepts {position:[x,y,z],target:[x,y,z],up:[x,y,z],projection:"perspective"|"orthographic",zoom:number}. Coordinates are CAD world coordinates in meters, with Z up. position is the camera eye; target is the point centered in the image and the orbit pivot. up controls image roll and must not be parallel to target-position.',
    "For relative adjustments, use state.camera.pose only when camera.kind is pose and camera.fit is null; otherwise capture first and use the returned cameraPose. To center on a point while preserving angle and distance, translate position by newTarget-oldTarget and set target to newTarget. To look at a point from a fixed eye, change only target. To zoom in/out, multiply/divide zoom (positive, at most 100000).",
    'For example: {expectedRevision:0,operations:[{type:"camera-pose",pose:{position:[0.2,-0.3,0.15],target:[0.02,0,0.01],up:[0,0,1],projection:"perspective",zoom:2}}]}. A camera-pose disables automatic fitting. A later fit recenters on the requested visible components (or all visible geometry for []) and resets zoom to 1, preserving the viewing direction and projection.',
    "Use the returned revision for the next update or capture. Changes remain private until captured.",
  ].join(" "),
  cad_capture:
    "Capture exactly expectedRevision as a PNG image and managed artifact. Returns cameraPose with the actual rendered position, target, up, projection, and zoom, including resolved preset/fit views. Reuse this pose in camera-pose to precisely recenter, change angle, or zoom, then capture again to inspect the result. Capturing does not change the view revision. The captured view is eligible for display to the user.",
} satisfies Record<keyof typeof CAD_TOOL_INPUTS, string>;

export const cadToolDefinitions = Object.entries(CAD_TOOL_INPUTS).map(([name, schema]) => {
  const document = Schema.toJsonSchemaDocument(schema);
  return {
    type: "function" as const,
    name,
    description: descriptions[name as keyof typeof descriptions],
    // Tool arguments are objects; Effect's empty Struct also encodes arrays unless narrowed.
    inputSchema: { ...document.schema, type: "object" as const, $defs: document.definitions },
  };
});
export interface CadToolDelivery {
  readonly result: unknown;
  readonly png?: Uint8Array;
}
export const invokeCadTool = Effect.fn("invokeCadTool")(function* (
  tools: CadAgentTools,
  name: string,
  input: unknown,
): Effect.fn.Return<CadToolDelivery, CadViewError> {
  switch (name) {
    case "cad_comments_list":
    case "cad_comment_locate":
    case "cad_comment_inspect":
    case "cad_comments_publish":
      if (!tools.comments) return yield* new CadViewError({ reason: "capability-unavailable" });
      return yield* tools.comments(name, input);
    case "cad_context":
      return { result: yield* tools.context() };
    case "cad_measure":
      return { result: yield* tools.measure(input) };
    case "cad_hierarchy":
      return { result: yield* tools.hierarchy(input) };
    case "cad_update_view":
      return { result: yield* tools.updateView(input) };
    case "cad_capture":
      return yield* tools.capture(input);
    default:
      return yield* new CadViewError({ reason: "capability-unavailable" });
  }
});

/** One native session owns these activations. Only trusted adapter callbacks supply child keys and turn IDs. */
export const makeCadProviderTools = Effect.fn("makeCadProviderTools")(function* (
  threadId: ThreadId,
) {
  const viewing = yield* CadViewing;
  const owner = yield* Scope.Scope;
  const gate = yield* Semaphore.make(1);
  const entries = new Map<
    string | null,
    { turnId: TurnId; scope: Scope.Closeable; tools: CadAgentTools }
  >();
  const ended = new Map<string | null, Set<TurnId>>();
  let open = true;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      open = false;
    }),
  );
  const get = Effect.fn("CadProviderTools.get")(function* (
    childKey: string | null,
    turnId: TurnId,
  ) {
    if (!open || ended.get(childKey)?.has(turnId))
      return yield* new CadViewError({ reason: "capability-unavailable" });
    const prior = entries.get(childKey);
    if (prior?.turnId === turnId) return prior;
    if (prior) {
      entries.delete(childKey);
      yield* Scope.close(prior.scope, Exit.void);
    }
    const contextId = yield* viewing.resolveContext(threadId, childKey ?? undefined);
    const scope = yield* Scope.fork(owner);
    const ready = yield* Deferred.make<CadAgentTools, CadViewError>();
    yield* viewing
      .withActivation(
        contextId,
        (tools) => Deferred.succeed(ready, tools).pipe(Effect.andThen(Effect.never)),
        turnId,
      )
      .pipe(
        Effect.catch((error) => Deferred.fail(ready, error)),
        Effect.forkIn(scope),
      );
    const tools = yield* Deferred.await(ready).pipe(
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void)),
    );
    const entry = { turnId, scope, tools };
    entries.set(childKey, entry);
    return entry;
  });
  const invoke = Effect.fn("CadProviderTools.invoke")(function* (
    childKey: string | null,
    turnId: TurnId,
    name: string,
    input: unknown,
  ) {
    const entry = yield* gate.withPermits(1)(get(childKey, turnId));
    if (!open) return yield* new CadViewError({ reason: "capability-unavailable" });
    const result = yield* Deferred.make<CadToolDelivery, CadViewError>();
    const call = yield* invokeCadTool(entry.tools, name, input).pipe(
      Effect.onExit((exit) => Deferred.done(result, exit)),
      Effect.forkIn(entry.scope),
    );
    return yield* Deferred.await(result).pipe(Effect.ensuring(Fiber.interrupt(call)));
  });
  const end = (childKey: string | null, turnId: TurnId) =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const turns = ended.get(childKey) ?? new Set<TurnId>();
        turns.add(turnId);
        ended.set(childKey, turns);
        const entry = entries.get(childKey);
        if (entry?.turnId !== turnId) return;
        entries.delete(childKey);
        yield* Scope.close(entry.scope, Exit.void);
      }),
    );
  const close = gate.withPermits(1)(
    Effect.gen(function* () {
      open = false;
      for (const entry of entries.values()) yield* Scope.close(entry.scope, Exit.void);
      entries.clear();
      ended.clear();
    }),
  );
  return { invoke, end, close };
});
export type CadProviderTools = Effect.Success<ReturnType<typeof makeCadProviderTools>>;
