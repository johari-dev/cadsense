import { CadSnapshotId, CadViewError, type CadCheckDraft } from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { placeCadDrafts } from "./CadCheckPlacement.ts";

// Cases from "Check-placed points" in cad/CadComments.md.

const snapshotId = CadSnapshotId.make("00000000-0000-4000-8000-000000000001");
const id = (seed: string) => seed.repeat(64).slice(0, 64);
const draft = (publicationKey: string, placed: boolean): CadCheckDraft => ({
  kind: "new",
  publicationKey,
  inspectedSnapshotId: snapshotId,
  title: publicationKey,
  body: `${publicationKey} body.`,
  severity: "blocker",
  category: "interference",
  targets: [
    { kind: "part", label: "40t gear", occurrenceId: id("a"), preciseLocationLimitation: "Whole." },
    { kind: "part", label: "Tube", occurrenceId: id("b"), preciseLocationLimitation: "Whole." },
  ],
  ...(placed
    ? {
        placements: [
          {
            occurrenceId: id("a"),
            point: [0.01, 0, 0] as const,
            normal: [1, 0, 0] as const,
            isolate: [id("a"), id("b")],
            expected: "where 40t gear meets Tube",
          },
        ],
      }
    : {}),
});
const result = (drafts: CadCheckDraft[]) => ({
  revision: 0,
  snapshotId,
  checks: ["drivetrain" as const],
  explanations: {},
  findings: [],
  drafts,
  nextCursor: null,
  summary: {
    totalFindings: 0,
    partOccurrences: 0,
    boundsUnknown: 0,
    meshUnknown: 0,
    pairsEvaluated: 0,
    pairBudget: 0,
    budgetExhausted: false,
  },
});
const decodePlaceInput = Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }));
type Outcome = "visible" | "occluded" | "fail" | "render-failed" | "part-missing";
/**
 * A comment activation whose placements are visible unless their key says otherwise. Like the real
 * activation, it reports a comment error as a result carrying `error`.
 */
const comments = (outcome: (key: string) => Outcome) => (name: string, input: unknown) => {
  assert.equal(name, "cad_comment_place");
  const { key } = decodePlaceInput(input);
  const kind = outcome(key);
  if (kind === "fail") return Effect.fail(new CadViewError({ reason: "render-unavailable" }));
  if (kind === "render-failed")
    return Effect.succeed({ result: { error: "render-invalid-result" } });
  if (kind === "part-missing")
    return Effect.succeed({ result: { error: "occurrence-unavailable" } });
  return Effect.succeed({
    result: {
      candidateId: `candidate-${key}`,
      inspectionId: kind === "visible" ? `inspection-${key}` : null,
    },
    png: new TextEncoder().encode(`png-${key}`),
  });
};
const run = (drafts: CadCheckDraft[], outcome: (key: string) => Outcome) =>
  placeCadDrafts(comments(outcome), result(drafts));
const text = (pngs: readonly Uint8Array[]) => pngs.map((png) => new TextDecoder().decode(png));

describe("placeCadDrafts", () => {
  it.effect("offers a visible placement as a point target and attaches its image", () =>
    Effect.gen(function* () {
      const placed = yield* run([draft("collision", true)], () => "visible");
      const [offered] = placed.result.drafts!;
      assert.isUndefined(offered?.placements);
      const [target] = offered!.targets;
      assert.equal(target?.kind, "point");
      if (target?.kind === "point") {
        assert.equal(target.label, "40t gear");
        assert.equal(target.candidateId, "candidate-collision");
        assert.equal(target.inspectionId, "inspection-collision");
      }
      assert.deepEqual(placed.result.draftImages, [{ publicationKey: "collision", image: 1 }]);
      assert.deepEqual(text(placed.pngs), ["png-collision"]);
    }),
  );

  it.effect("keeps whole-part targets when the inspection shows the marker hidden", () =>
    Effect.gen(function* () {
      const placed = yield* run([draft("collision", true)], () => "occluded");
      assert.isTrue(placed.result.drafts![0]!.targets.every((target) => target.kind === "part"));
      assert.isUndefined(placed.result.drafts![0]!.placements);
      assert.deepEqual(placed.pngs, []);
    }),
  );

  it.effect("keeps whole-part targets when placement fails, without failing the checks", () =>
    Effect.gen(function* () {
      const placed = yield* run([draft("collision", true), draft("plain", false)], () => "fail");
      assert.deepEqual(
        placed.result.drafts!.map((d) => d.targets.length),
        [2, 2],
      );
      assert.isUndefined(placed.result.draftImages);
    }),
  );

  it.effect("stops placing once a render fails, so the checks stay quick", () =>
    Effect.gen(function* () {
      const asked: string[] = [];
      const placed = yield* run([draft("first", true), draft("second", true)], (key) => {
        asked.push(key);
        return key === "first" ? "render-failed" : "visible";
      });
      assert.deepEqual(asked, ["first"]);
      assert.isTrue(
        placed.result.drafts!.every((d) => d.targets.every((target) => target.kind === "part")),
      );
      assert.isUndefined(placed.result.draftImages);
    }),
  );

  it.effect("keeps placing after a failure that concerns only one draft", () =>
    Effect.gen(function* () {
      const placed = yield* run([draft("first", true), draft("second", true)], (key) =>
        key === "first" ? "part-missing" : "visible",
      );
      assert.deepEqual(placed.result.draftImages, [{ publicationKey: "second", image: 1 }]);
    }),
  );

  it.effect("numbers images by the drafts that got one", () =>
    Effect.gen(function* () {
      const placed = yield* run([draft("first", true), draft("second", true)], (key) =>
        key === "first" ? "occluded" : "visible",
      );
      assert.deepEqual(placed.result.draftImages, [{ publicationKey: "second", image: 1 }]);
      assert.deepEqual(text(placed.pngs), ["png-second"]);
    }),
  );

  it.effect("keeps every visible marker of a merged draft, and the part of a hidden one", () =>
    Effect.gen(function* () {
      const merged: CadCheckDraft = {
        ...draft("shafts", false),
        targets: [
          {
            kind: "part",
            label: "Shaft A",
            occurrenceId: id("c"),
            preciseLocationLimitation: "Whole.",
          },
          {
            kind: "part",
            label: "Shaft B",
            occurrenceId: id("d"),
            preciseLocationLimitation: "Whole.",
          },
          {
            kind: "part",
            label: "Controller",
            occurrenceId: id("e"),
            preciseLocationLimitation: "Whole.",
          },
        ],
        placements: ["c", "d"].map((seed) => ({
          occurrenceId: id(seed),
          point: [0, 0, 0] as const,
          normal: [1, 0, 0] as const,
          isolate: [id(seed), id("e")],
          expected: `where shaft ${seed} meets the controller`,
        })),
      };
      let calls = 0;
      const placed = yield* placeCadDrafts(
        comments(() => (++calls === 1 ? "visible" : "occluded")),
        result([merged]),
      );
      const targets = placed.result.drafts![0]!.targets;
      assert.deepEqual(
        targets.map((target) => [target.kind, target.label]),
        [
          ["point", "Shaft A"],
          ["part", "Shaft B"],
        ],
      );
      assert.deepEqual(placed.result.draftImages, [{ publicationKey: "shafts", image: 1 }]);
    }),
  );

  it.effect("strips placements when the activation has no comment tools", () =>
    Effect.gen(function* () {
      const placed = yield* placeCadDrafts(undefined, result([draft("a", true)]));
      assert.isUndefined(placed.result.drafts![0]!.placements);
      assert.deepEqual(placed.pngs, []);
    }),
  );
});
