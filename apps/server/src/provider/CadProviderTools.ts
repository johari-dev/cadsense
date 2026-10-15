import {
  CAD_CAPTURE_SIZE,
  CAD_TOOL_INPUTS,
  CadChecksResult,
  CadViewError,
  type ThreadId,
  type TurnId,
} from "@cadsense/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { CAD_DRAFT_DECLINE_RULE } from "../cad/CadChecks.ts";
import { CadViewing, type CadAgentTools } from "../cad/CadViewing.ts";
import { placeCadDrafts } from "./CadCheckPlacement.ts";
import {
  type CadDraftLedger,
  makeCadDraftLedger,
  presentRemaining,
  recordCadChecks,
  remainingDrafts,
  settleDrafts,
  preparePublication,
  currentCatalogVersion,
  presentPending,
  followUpMessage,
  recordPublished,
} from "./CadCheckBackstop.ts";
import { acceptShortIds, makeCadShortIds } from "./CadShortIds.ts";

const descriptions = {
  cad_comments_list:
    "List this chat's CAD findings, including reviewed findings, before publishing. Paginate with the returned catalogVersion/cursor. Reuse unchanged findings without reopening them. A comment with outdated set describes a part that was removed, moved, or reshaped in the current model: re-verify it before proposing resolution or a follow-up.",
  cad_comment_locate: `Pick candidate surface locations from a specific retained capture. Input: {captureId,picks:[{pickKey:"hole-1",intendedOccurrenceId,x:530,y:456}]}. All four pick fields are required. x/y are original-image pixels with top-left origin (${CAD_CAPTURE_SIZE.width} by ${CAD_CAPTURE_SIZE.height}), not pixelX/pixelY. A pick that misses moves to the nearest pixel within 64 where the intended part is visible; the result's pixel says where. Use the occurrence ID from cad_hierarchy. A hit is not semantic verification: an opening may hit an inner wall. Inspect candidates before publishing precise targets; if input is rejected, correct the fields identified in details and retry.`,
  cad_comment_inspect:
    "Receive an annotated alternate view of candidate locations. Visually verify each surface and depth. Publish verified screw holes as separate precise comments; do not group them into a whole-part finding because other candidates are occluded. Inspect remaining candidates individually to choose a better angle, or capture a closer alternate view and locate a reliable rim. Render errors require retry, not a claim that precise location is unavailable. Use a whole-part target when the issue concerns the whole part, such as a duplicate or misplaced part, or after attempts to locate and verify the specific spot remain uncertain. This does not move the user view.",
  cad_comments_publish: [
    "Before publishing, check each comment against the CAD review instructions: one useful issue at its marked location, consistent with the intended motion, supported by observations rather than assumptions, and written so the user understands the next decision without the chat. Rewrite comments that fail this check; drop only findings you cannot support.",
    'Publish complete verified findings incrementally. Input: {expectedCatalogVersion,items:[{kind:"new",publicationKey,inspectedSnapshotId,title,body,severity,category,targets:[{kind:"point",label,candidateId,inspectionId,confirmationReason}]}]}. Each new item requires all eight fields shown. Use expectedCatalogVersion from cad_comments_list and inspectedSnapshotId from the inspected cad_capture.snapshotId (or cad_context.state.snapshotId for a whole-part finding).',
    "severity rates the consequence to the mechanism: blocker breaks function or safety, concern likely causes a problem, question needs the designer's answer, nit is cosmetic. category names the lifecycle stage the finding affects: interference (parts collide or rub), access (tools, service, or removal), assembly (fastening and build order), wiring (cable routing and strain), structure (stiffness, load, or mounting), manufacturing (making the part), or other.",
    'Precise targets require successful cad_comment_locate then cad_comment_inspect and your visual confirmation of the alternate image. When the precise location cannot be verified, targets may instead contain {kind:"part",label,occurrenceId,preciseLocationLimitation}. The limitation belongs inside each target. Use targets (an array), not target; valid target kinds are point and part, not whole-part. Do not invent coordinates or verification IDs.',
    'To reuse: {expectedCatalogVersion,items:[{kind:"reuse",publicationKey,inspectedSnapshotId,reuseCommentId}]}. A new finding may also include link:{kind:"correction"|"follow-up",commentId,explanation} for materially new evidence. Published content and review state cannot be edited by the agent.',
    'When a newer model shows an open comment was addressed, propose resolution: {kind:"propose-resolve",publicationKey,inspectedSnapshotId,commentId,explanation}. The inspected snapshot must be newer than the comment\'s and the explanation must cite what you verified in the new geometry. The user confirms; the comment stays open until then. Comments listed with outdated set need this re-verification first.',
    "To publish cad_checks drafts exactly as offered, pass publishDrafts:[publicationKey]; expectedCatalogVersion and items may then be left out. Results list remainingDrafts: proven defects no comment covers yet.",
    CAD_DRAFT_DECLINE_RULE,
    "Check every result: tool completion does not mean publication succeeded. For invalid-input, correct the fields identified in details and retry; failed items did not publish. Retry identical successful requests with stable publicationKey values. Empty holes alone do not prove screws are required: describe the evidence and uncertainty accurately.",
  ].join(" "),
  cad_context:
    "Read your private CAD view revision, state, and locally available scene roots. Start CAD reviews here and inspect the downloaded model with the CAD tools.",
  cad_hierarchy:
    "Read a bounded page of the selected CAD component tree with occurrence visibility. Part entries include material and massKg when Onshape has them; a missing massKg means unknown, not zero. Mass is per occurrence, so sum parts yourself and say which have no mass.",
  cad_checks: [
    'Run deterministic checks over every unsuppressed part in the selected root and read a page of findings with occurrence IDs. Input: {expectedRevision, checks?:["drivetrain","mesh-interference","overlapping-bounds","coincident-instances","degenerate-geometry"], cursor?, limit?}. Default: everything except overlapping-bounds.',
    "drivetrain findings come first. They trace power from each motor through recognized gears, belts, chains, and shafts, check gear center distances and belt or chain lengths, and find shafts with no bearing. A drivetrain finding with problem: true is a verified defect in the model as drawn: comment on each one.",
    "The first page also returns drafts: one ready cad_comments_publish item per proven defect (drivetrain problems, spinning parts running into other parts, and near-total duplicates). Where the checks prove the spot, the draft already has an inspected point target, and draftImages names the image attached to this result that shows its marker: look at it before publishing. Other drafts have whole-part targets as a fallback. Reword them for the student, replace a whole-part target with a located and inspected point when the problem sits at one spot, add expectedCatalogVersion from cad_comments_list, and publish them.",
    CAD_DRAFT_DECLINE_RULE,
    "mesh-interference lists part pairs whose solids actually intersect, with a plain-language reading of each, ordered so likely duplicates and real collisions come before overlaps inside one subassembly, squeezed game pieces, and fastener threads. Intended fits touch at zero volume. coincident-instances lists duplicate placements of one part; degenerate-geometry lists parts with unknown or near-zero bounds.",
    "Treat each duplicate or collision reading as a problem to explain, not a hint: capture the pair isolated and say what is wrong or ask why it is intended. summary.meshUnknown counts parts that are not closed solids; request overlapping-bounds for bounding-box leads on those. Read summary.budgetExhausted to know whether every pair was evaluated. Each page states every selected check's explanation once in explanations; a page may hold fewer findings than limit to stay small, so follow nextCursor.",
  ].join(" "),
  cad_diff:
    "Compare two retained snapshots of the selected root and list what changed: added, removed, moved (placement relative to the parent), geometry-changed, renamed, suppression-changed, and visibility-changed occurrences with IDs on both sides. targetSnapshotId defaults to the current snapshot; baseSnapshotId defaults to the newest earlier retained snapshot, such as the one earlier comments inspected, and baseSelection explains the choice. retainedSnapshots lists the bases available with createdAt and microversion. Page with nextCursor. Use it when earlier comments exist to focus on changed components and reuse unchanged findings; it changes no view state.",
  cad_measure:
    'Read bounded measurements at {expectedRevision,snapshotId}. For points use {mode:"point-distance",from:{space:"world",point:[x,y,z]},to:{space:"part",occurrenceId,point:[x,y,z]}}. Coordinates are meters in original assembled Z-up world or part CAD coordinates before the occurrence transform. Points are caller-specified and unverified; never copy exploded display coordinates. For approximate unsigned triangle-surface separation use {mode:"surface-clearance",fromOccurrenceId,toOccurrenceId}, with part occurrence IDs from cad_hierarchy. Geometry uses original assembled placements regardless of visibility or explosion. Check status: unknown has no measurement. Positive surface distance does not exclude solid containment, and zero does not prove penetration. Results provide mesh provenance and uncertainty, not manufacturing tolerance.',
  cad_find_parts:
    "Search the selected cached snapshot using snapshotId and expectedRevision from cad_context. nameQuery and materialName are case-insensitive substrings; bodyType is a case-insensitive exact match. sourcePartKey finds repeated instances of the same source/configuration. kind defaults to part; use all to include assemblies. visibility defaults to all and uses effective visibility, including hidden ancestors, isolation and suppression. All supplied filters combine. Results contain stable occurrence IDs, source identity, assembly paths, and bounds, the part's world box {min,max,size} in meters at its assembled placement (Z up, explosion ignored; null when suppressed, not a part, or unknown). No filters returns a bounded page. limit defaults to 25, maximum 50. Serialized results are capped at 64 KiB, so pages may contain fewer entries than limit. Continue with nextCursor and the same filters, limit, snapshot and revision. Order follows the immutable manifest. Missing metadata and material names are explicit; massKg is per occurrence and null means unknown, not zero. Text fields are capped at 256 characters; paths retain the nearest 16 ancestors, with truncation indicators. Reads only stored part bounds, never the network; the view is unchanged.",
  cad_update_view: [
    'Atomically update your private CAD view at expectedRevision. operations is an ordered array of tagged objects: {type:"select-root",rootId}, {type:"camera-preset",preset}, {type:"camera-pose",pose}, {type:"fit",occurrenceIds:[]}, {type:"show"|"hide"|"isolate",occurrenceIds:[id]}, {type:"reset-visibility"}, or {type:"explode",amount:0..1}.',
    'You can use arbitrary camera angles and origins beyond the toolbar presets. camera-pose accepts {position:[x,y,z],target:[x,y,z],up:[x,y,z],projection:"perspective"|"orthographic",zoom:number}. Coordinates are CAD world coordinates in meters, with Z up. position is the camera eye; target is the point centered in the image and the orbit pivot. up controls image roll and must not be parallel to target-position.',
    "For relative adjustments, use state.camera.pose only when camera.kind is pose and camera.fit is null; otherwise capture first and use the returned cameraPose. To center on a point while preserving angle and distance, translate position by newTarget-oldTarget and set target to newTarget. To look at a point from a fixed eye, change only target. To zoom in/out, multiply/divide zoom (positive, at most 100000).",
    'For example: {expectedRevision:0,operations:[{type:"camera-pose",pose:{position:[0.2,-0.3,0.15],target:[0.02,0,0.01],up:[0,0,1],projection:"perspective",zoom:2}}]}. A camera-pose disables automatic fitting. A later fit recenters on the requested visible components (or all visible geometry for []) and resets zoom to 1, preserving the viewing direction and projection.',
    'Inspection operations replace their previous selection: {type:"highlight",occurrenceIds:[id]} applies amber highlighting; {type:"ghost",occurrenceIds:[id],opacity:0.05..0.95} makes those subtrees translucent. Empty occurrenceIds clears that effect. {type:"section",planes:[{normal:[1,0,0],constant:0}]} replaces up to 6 clipping planes; [] clears sections. Normals must have unit length; constants are meters, bounded to ±1e9. A point remains visible when dot(normal,point)+constant>=0 for every plane. Planes use displayed world coordinates after explosion. Sections are uncapped mesh clipping, not CAD cuts or measurable geometry. Transparent front surfaces make point picking ambiguous; hide them or reset ghosting before locating a precise comment. {type:"reset-inspection"} clears highlight, ghosting, and sections without changing camera, explosion, or visibility.',
    "Use the returned revision for the next update or capture. Changes remain private until captured.",
    "An invalid-operation error includes details naming the field or operation to correct; fix it and retry.",
  ].join(" "),
  cad_capture:
    "Capture exactly expectedRevision as a PNG image and managed artifact. Returns cameraPose with the actual rendered position, target, up, projection, and zoom, including resolved preset/fit views. Reuse this pose in camera-pose to precisely recenter, change angle, or zoom, then capture again to inspect the result. Capturing does not change the view revision. The captured view is eligible for display to the user. render-* errors are rendering failures, not CAD being off: follow their details to recover.",
} satisfies Record<keyof typeof CAD_TOOL_INPUTS, string>;

/** Tools that change no view, comment, or evidence state. MCP clients receive this as readOnlyHint. */
export const CAD_READ_ONLY_TOOLS: ReadonlySet<string> = new Set<keyof typeof CAD_TOOL_INPUTS>([
  "cad_comments_list",
  "cad_context",
  "cad_hierarchy",
  "cad_checks",
  "cad_diff",
  "cad_measure",
  "cad_find_parts",
]);

export const cadToolDefinitions = Object.entries(CAD_TOOL_INPUTS).map(([name, schema]) => {
  const document = Schema.toJsonSchemaDocument(schema);
  return {
    type: "function" as const,
    name,
    description: descriptions[name as keyof typeof descriptions],
    // Tool arguments are objects; Effect's empty Struct also encodes arrays unless narrowed.
    inputSchema: acceptShortIds({
      ...document.schema,
      type: "object" as const,
      $defs: document.definitions,
    }),
  };
});
/** `tools/list` entries for MCP clients, with read-only hints. */
export const mcpCadToolDefinitions = cadToolDefinitions.map(({ type: _type, ...tool }) => ({
  ...tool,
  annotations: {
    readOnlyHint: CAD_READ_ONLY_TOOLS.has(tool.name),
    destructiveHint: false,
    openWorldHint: false,
  },
}));
export interface CadToolDelivery {
  readonly result: unknown;
  readonly png?: Uint8Array;
  /** More images after `png`, such as the inspection images for cad_checks drafts. */
  readonly pngs?: readonly Uint8Array[];
}
/** Every image a delivery carries, in the order the agent should see them. */
export const cadDeliveryImages = (delivery: CadToolDelivery): Uint8Array[] => [
  ...(delivery.png ? [delivery.png] : []),
  ...(delivery.pngs ?? []),
];
const encodeDeliveryResult = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeCadViewError = Schema.encodeSync(Schema.fromJsonString(CadViewError));
/** MCP `tools/call` result for a CAD tool: the result as JSON text and structured content, plus any render. */
export const mcpCadToolResult = (delivery: CadToolDelivery) =>
  encodeDeliveryResult(delivery.result).pipe(
    Effect.mapError(() => new CadViewError({ reason: "capability-unavailable" })),
    Effect.map((text) => ({
      isError: false,
      structuredContent: delivery.result,
      content: [
        { type: "text" as const, text },
        ...cadDeliveryImages(delivery).map((png) => ({
          type: "image" as const,
          mimeType: "image/png",
          data: Buffer.from(png).toString("base64"),
        })),
      ],
    })),
  );
/** MCP `tools/call` result for a failed CAD tool. Agents read `reason` and `details` to recover. */
export const mcpCadToolError = (error: CadViewError) => ({
  isError: true,
  content: [{ type: "text" as const, text: encodeCadViewError(error) }],
});
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
    case "cad_hierarchy":
      return { result: yield* tools.hierarchy(input) };
    case "cad_checks":
      return { result: yield* tools.checks(input) };
    case "cad_diff":
      return { result: yield* tools.diff(input) };
    case "cad_measure":
      return { result: yield* tools.measure(input) };
    case "cad_find_parts":
      return { result: yield* tools.findParts(input) };
    case "cad_update_view":
      return { result: yield* tools.updateView(input) };
    case "cad_capture":
      return yield* tools.capture(input);
    default:
      return yield* new CadViewError({ reason: "capability-unavailable" });
  }
});

const decodeChecksResult = Schema.decodeUnknownOption(CadChecksResult);
const REMINDER = `These cad_checks drafts describe proven defects that no comment in this chat covers yet. Publish each one, reworded for the student. ${CAD_DRAFT_DECLINE_RULE} Drafts still uncovered when the turn ends are published as drafted.`;

/**
 * How a turn ended. A `completed` main-agent turn publishes its leftover drafts, and so does a
 * `failed` one after its follow-up was sent: the review had finished and only the follow-up failed.
 * A `stopped` turn (the user pressed Stop, or child agents were still running) publishes nothing.
 */
export type CadTurnOutcome = "completed" | "failed" | "stopped";

/**
 * One native session owns these activations. Only trusted adapter callbacks supply child keys and
 * turn IDs. `settleOnClose` makes closing the session publish leftover drafts too, for `cadsense mcp`,
 * where the session is the review; an app session that closes publishes nothing.
 */
export const makeCadProviderTools = Effect.fn("makeCadProviderTools")(function* (
  threadId: ThreadId,
  options: { readonly settleOnClose?: boolean } = {},
) {
  const viewing = yield* CadViewing;
  const owner = yield* Scope.Scope;
  const gate = yield* Semaphore.make(1);
  const entries = new Map<
    string | null,
    {
      turnId: TurnId;
      scope: Scope.Closeable;
      tools: CadAgentTools;
      ledger: CadDraftLedger;
      settle: boolean;
    }
  >();
  const ended = new Map<string | null, Set<TurnId>>();
  // The main agent's declines and sent drafts last the session: a later turn on the same snapshot
  // drafts the same keys.
  const session = { declined: new Map<string, string>(), sent: new Map<string, unknown>() };
  // Shared by the session's child agents so IDs one shows, another can use.
  const ids = makeCadShortIds();
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
    const entry = {
      turnId,
      scope,
      tools,
      ledger: makeCadDraftLedger(childKey === null ? session : undefined),
      settle: childKey === null && options.settleOnClose === true,
    };
    // Scope finalizers run newest first, so this backstop runs before the activation above stops,
    // however the scope closes. It publishes only once armed: by `end` for a completed main-agent
    // turn, or from the start over MCP. See "Drafts, reminders, and the backstop" in CadChecks.md.
    yield* Scope.addFinalizer(
      scope,
      Effect.suspend(() => (entry.settle ? settleDrafts(tools, entry.ledger) : Effect.void)).pipe(
        Effect.catchCause((cause) => Effect.logWarning("CAD check backstop failed", cause)),
      ),
    );
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
    const expanded = ids.expand(input);
    if (!expanded.ok)
      return yield* new CadViewError({ reason: "invalid-operation", details: expanded.details });
    const publishing = name === "cad_comments_publish";
    const prepared = publishing ? preparePublication(entry.ledger, expanded.value) : null;
    /** Recomputes the uncovered drafts and returns the publish-result reminder for them. */
    const refreshRemaining = remainingDrafts(entry.tools, entry.ledger).pipe(
      Effect.orElseSucceed(() => []),
      Effect.tap((remaining) => {
        const pending = remaining.map((draft) => draft.publicationKey);
        const changed = pending.join(" ") !== entry.ledger.pending.join(" ");
        entry.ledger.pending = pending;
        // Logged so a host (or the e2e harness) can follow up when a turn ends with drafts pending.
        return changed
          ? Effect.logInfo("CAD drafts pending", {
              count: pending.length,
              publicationKeys: pending,
            })
          : Effect.void;
      }),
      Effect.map((remaining) => presentRemaining(remaining, REMINDER)),
    );
    // A call that only declines or names unusable drafts has nothing for the comment service.
    if (prepared?.itemCount === 0)
      return {
        result: ids.shorten({
          results: prepared.rejected,
          declined: [...entry.ledger.declined.keys()],
          ...(yield* refreshRemaining),
        }),
      };
    const forwardInput =
      prepared?.catalogMissing && typeof prepared.input === "object" && prepared.input !== null
        ? {
            ...prepared.input,
            expectedCatalogVersion: yield* currentCatalogVersion(entry.tools).pipe(
              Effect.orElseSucceed(() => 0),
            ),
          }
        : (prepared?.input ?? expanded.value);
    const result = yield* Deferred.make<CadToolDelivery, CadViewError>();
    const call = yield* invokeCadTool(entry.tools, name, forwardInput).pipe(
      Effect.onExit((exit) => Deferred.done(result, exit)),
      Effect.forkIn(entry.scope),
    );
    const delivery = yield* Deferred.await(result).pipe(
      Effect.ensuring(Fiber.interrupt(call)),
      Effect.mapError((error) =>
        error.details === undefined
          ? error
          : new CadViewError({ reason: error.reason, details: ids.shorten(error.details) }),
      ),
    );
    if (name === "cad_checks") {
      const checks = decodeChecksResult(delivery.result);
      if (Option.isSome(checks)) {
        // Check-proven spots become inspected point targets before the agent sees the drafts.
        const placed = yield* placeCadDrafts(
          entry.tools.comments,
          checks.value,
          entry.ledger.placements,
        );
        recordCadChecks(entry.ledger, checks.value, placed.result);
        yield* refreshRemaining;
        return { ...delivery, result: ids.shorten(placed.result), pngs: placed.pngs };
      }
    }
    if (typeof delivery.result !== "object" || delivery.result === null)
      return { ...delivery, result: ids.shorten(delivery.result) };
    if (!publishing)
      return {
        ...delivery,
        result: ids.shorten({ ...delivery.result, ...presentPending(entry.ledger.pending) }),
      };
    if (prepared) recordPublished(entry.ledger, prepared.items, delivery.result);
    // After each publication, name the proven defects that still have no comment.
    const reminder = yield* refreshRemaining;
    const results =
      "results" in delivery.result && Array.isArray(delivery.result.results)
        ? [...delivery.result.results, ...(prepared?.rejected ?? [])]
        : prepared?.rejected;
    return {
      ...delivery,
      result: ids.shorten({ ...delivery.result, ...(results ? { results } : {}), ...reminder }),
    };
  });
  /**
   * Asked by an adapter when its agent tries to end a turn. Returns the message that sends the agent
   * back to the drafts no comment covers and it did not decline, at most once per activation, and
   * null otherwise. It never starts or ends an activation; see "The follow-up" in cad/CadChecks.md.
   */
  const followUp = (childKey: string | null, turnId: TurnId) =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const entry = entries.get(childKey);
        if (!open || entry?.turnId !== turnId || entry.ledger.followedUp) return null;
        const remaining = yield* remainingDrafts(entry.tools, entry.ledger).pipe(
          Effect.orElseSucceed(() => []),
        );
        if (remaining.length === 0) return null;
        entry.ledger.followedUp = true;
        yield* Effect.logInfo("CAD follow-up sent", {
          publicationKeys: remaining.map((draft) => draft.publicationKey),
        });
        return followUpMessage(remaining);
      }),
    );
  /** Ends a turn's activation; see CadTurnOutcome for which turns publish their leftover drafts. */
  const end = (childKey: string | null, turnId: TurnId, outcome: CadTurnOutcome) =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const turns = ended.get(childKey) ?? new Set<TurnId>();
        turns.add(turnId);
        ended.set(childKey, turns);
        const entry = entries.get(childKey);
        if (entry?.turnId !== turnId) return;
        if (
          childKey === null &&
          (outcome === "completed" || (outcome === "failed" && entry.ledger.followedUp))
        )
          entry.settle = true;
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
  return { invoke, followUp, end, close };
});
export type CadProviderTools = Effect.Success<ReturnType<typeof makeCadProviderTools>>;
