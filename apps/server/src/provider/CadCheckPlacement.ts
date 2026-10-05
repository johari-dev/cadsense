import type { CadCheckDraft, CadChecksResult } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { CadAgentTools } from "../cad/CadViewing.ts";

const PlaceResult = Schema.Struct({
  candidateId: Schema.String,
  // Null when the inspection shows the marker hidden, so it cannot be published as a point.
  inspectionId: Schema.NullOr(Schema.String),
});
const decodePlace = Schema.decodeUnknownOption(PlaceResult);
// The comment activation reports its errors as results; render failures have a `render-` reason.
const decodeFailure = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }));
const isRenderFailure = (result: unknown) =>
  Option.exists(decodeFailure(result), (failure) => failure.error.startsWith("render-"));

/**
 * Turns each draft's check-proven placements into point targets the agent can publish as offered:
 * the comment activation registers the candidate and inspects it (internal `cad_comment_place`),
 * and the inspection image is attached to the cad_checks result. A part whose marker is hidden in
 * its inspection or fails to render keeps its part target; a draft with no visible marker, or no
 * comment activation, keeps all its whole-part targets. Once a render fails, no more placements are
 * tried: a struggling renderer would make each one wait out its render, holding up cad_checks for
 * minutes. Placements never reach the agent. Images are numbered in the order they were attached. A
 * result without drafts (a later page) passes through unchanged.
 * See "Check-placed points" in cad/CadComments.md.
 */
export const placeCadDrafts = Effect.fn("placeCadDrafts")(function* (
  comments: CadAgentTools["comments"],
  checks: CadChecksResult,
) {
  const pngs: Uint8Array[] = [];
  if (!checks.drafts) return { result: checks, pngs };
  const draftImages: { publicationKey: string; image: number }[] = [];
  const offered: CadCheckDraft[] = [];
  let rendering = true;
  for (const draft of checks.drafts) {
    const { placements, ...plain } = draft;
    if (!placements?.length || !comments) {
      offered.push(plain);
      continue;
    }
    // One point target per visible marker; a part whose marker is hidden keeps its part target.
    const targets: CadCheckDraft["targets"][number][] = [];
    for (const placement of placements) {
      const part = plain.targets.find(
        (target) => target.kind === "part" && target.occurrenceId === placement.occurrenceId,
      );
      if (!rendering) {
        if (part) targets.push(part);
        continue;
      }
      const placed = yield* comments("cad_comment_place", {
        key: draft.publicationKey,
        snapshotId: draft.inspectedSnapshotId,
        placement,
      }).pipe(Effect.option);
      if (Option.isNone(placed) || isRenderFailure(placed.value.result)) rendering = false;
      const outcome = Option.flatMap(placed, (delivery) => decodePlace(delivery.result));
      const png = Option.isSome(placed) ? placed.value.png : undefined;
      if (Option.isNone(outcome) || outcome.value.inspectionId === null || !png) {
        if (part) targets.push(part);
        continue;
      }
      pngs.push(png);
      const image = pngs.length;
      draftImages.push({ publicationKey: draft.publicationKey, image });
      targets.push({
        kind: "point",
        label: part?.label ?? "Marked spot",
        candidateId: outcome.value.candidateId,
        inspectionId: outcome.value.inspectionId,
        confirmationReason: `Cadsense's checks placed this marker ${placement.expected}; image ${image} of the cad_checks result shows it.`,
      });
    }
    offered.push(targets.some((target) => target.kind === "point") ? { ...plain, targets } : plain);
  }
  return {
    result: { ...checks, drafts: offered, ...(draftImages.length > 0 ? { draftImages } : {}) },
    pngs,
  };
});
