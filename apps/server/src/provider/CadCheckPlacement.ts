import type { CadCheckDraft, CadChecksResult } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
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
 * One turn's placements by draft key and part (`placed`): the visible marker and its image, or null
 * when the marker was hidden. Draft keys name the snapshot, so a newer model is never served from
 * it. `lock` runs one placement at a time, so two cad_checks calls at once share each marker.
 */
export interface CadPlacementCache {
  readonly placed: Map<
    string,
    { readonly candidateId: string; readonly inspectionId: string; readonly png: Uint8Array } | null
  >;
  readonly lock: Semaphore.Semaphore;
}
export const makeCadPlacementCache = (): CadPlacementCache => ({
  placed: new Map(),
  lock: Semaphore.makeUnsafe(1),
});

/**
 * Turns each draft's check-proven placements into point targets the agent can publish as offered:
 * the comment activation registers the candidate and inspects it (internal `cad_comment_place`),
 * and the inspection image is attached to the cad_checks result. A part whose marker is hidden in
 * its inspection or fails to render keeps its part target; a draft with no visible marker, or no
 * comment activation, keeps all its whole-part targets. Once a render fails, no more placements are
 * tried: a struggling renderer would make each one wait out its render, holding up cad_checks for
 * minutes. A placement already in `cache` is offered again without rendering and without its image,
 * which the agent saw earlier in the turn: agents call cad_checks several times a turn. Placements
 * never reach the agent. Images are numbered in the order they were attached. A result without
 * drafts (a later page) passes through unchanged. See "Check-placed points" in cad/CadComments.md.
 */
export const placeCadDrafts = Effect.fn("placeCadDrafts")(function* (
  comments: CadAgentTools["comments"],
  checks: CadChecksResult,
  cache: CadPlacementCache = makeCadPlacementCache(),
) {
  const pngs: Uint8Array[] = [];
  if (!checks.drafts) return { result: checks, pngs };
  const drafts = checks.drafts;
  return yield* cache.lock.withPermits(1)(
    Effect.gen(function* () {
      const draftImages: { publicationKey: string; image: number }[] = [];
      const offered: CadCheckDraft[] = [];
      let rendering = true;
      for (const draft of drafts) {
        const { placements, ...plain } = draft;
        if (!placements?.length || !comments) {
          offered.push(plain);
          continue;
        }
        // One point target per visible marker; a part whose marker is hidden keeps its part target.
        const targets: CadCheckDraft["targets"][number][] = [];
        // One comment takes at most 20 targets.
        for (const placement of placements.slice(0, 20)) {
          const part = plain.targets.find(
            (target) => target.kind === "part" && target.occurrenceId === placement.occurrenceId,
          );
          const cacheKey = `${draft.publicationKey} ${placement.occurrenceId}`;
          let visible = cache.placed.get(cacheKey);
          let png: Uint8Array | undefined;
          if (visible === undefined && rendering) {
            const placed = yield* comments("cad_comment_place", {
              key: draft.publicationKey,
              snapshotId: draft.inspectedSnapshotId,
              placement,
            }).pipe(Effect.option);
            if (Option.isNone(placed) || isRenderFailure(placed.value.result)) rendering = false;
            const outcome = Option.flatMap(placed, (delivery) => decodePlace(delivery.result));
            png = Option.isSome(placed) ? placed.value.png : undefined;
            // Only a finished inspection is remembered; a failed render may succeed later.
            if (Option.isSome(outcome) && png) {
              const { candidateId, inspectionId } = outcome.value;
              visible = inspectionId === null ? null : { candidateId, inspectionId, png };
              cache.placed.set(cacheKey, visible);
            }
          }
          if (!visible) {
            if (part) targets.push(part);
            continue;
          }
          if (png) {
            pngs.push(png);
            draftImages.push({ publicationKey: draft.publicationKey, image: pngs.length });
          }
          // The same words on every offer, so publishing the draft again replays it.
          targets.push({
            kind: "point",
            label: part?.label ?? "Marked spot",
            candidateId: visible.candidateId,
            inspectionId: visible.inspectionId,
            confirmationReason: `Cadsense's checks placed this marker ${placement.expected} and inspected it; draftImages in the cad_checks result that first offered this draft names the image.`,
          });
        }
        offered.push(
          targets.some((target) => target.kind === "point") ? { ...plain, targets } : plain,
        );
      }
      return {
        result: {
          ...checks,
          drafts: offered,
          ...(draftImages.length > 0 ? { draftImages } : {}),
        },
        pngs,
      };
    }),
  );
});
