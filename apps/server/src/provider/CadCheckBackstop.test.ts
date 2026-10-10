import {
  CadCommentPublication,
  CadSnapshotId,
  type CadCheckDraft,
  type CadCheckFinding,
  type CadChecksResult,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { draftCadComments } from "../cad/CadChecks.ts";
import type { CadAgentTools } from "../cad/CadViewing.ts";
import {
  backstopItem,
  BACKSTOP_NOTE,
  followUpMessage,
  type CadDraftLedger,
  makeCadDraftLedger,
  recordCadChecks,
  preparePublication,
  recordPublished,
  settleDrafts,
  uncoveredDrafts,
} from "./CadCheckBackstop.ts";

// Cases from "Drafts, reminders, and the backstop" in cad/CadChecks.md.

const id = (seed: string) => seed.repeat(64).slice(0, 64);
const draft = (publicationKey: string, ...occurrenceIds: string[]): CadCheckDraft => ({
  kind: "new",
  publicationKey,
  inspectedSnapshotId: CadSnapshotId.make("00000000-0000-4000-8000-000000000001"),
  title: publicationKey,
  body: `${publicationKey} body`,
  severity: "blocker",
  category: "assembly",
  targets: occurrenceIds.map((occurrenceId) => ({
    kind: "part",
    label: "part",
    occurrenceId,
    preciseLocationLimitation: "whole part",
  })),
});
const comment = (...occurrenceIds: string[]) => ({
  targets: occurrenceIds.map((occurrenceId) => ({ occurrenceId })),
});

const gears = draft("gear-spacing", id("a"), id("b"));
const belt = draft("bare-belt", id("c"));
const shafts = draft("no-bearing", id("d"), id("e"));

describe("uncoveredDrafts", () => {
  it("keeps every draft when the chat has no comments", () => {
    expect(uncoveredDrafts([gears, belt], [], new Set())).toEqual([gears, belt]);
  });

  it("drops a draft once any comment targets one of its parts", () => {
    expect(
      uncoveredDrafts([gears, belt, shafts], [comment(id("b")), comment(id("e"))], new Set()),
    ).toEqual([belt]);
  });

  it("drops a draft the agent declined", () => {
    expect(uncoveredDrafts([gears, belt], [], new Set(["bare-belt"]))).toEqual([gears]);
  });

  it("ignores comments on parts no draft names", () => {
    expect(uncoveredDrafts([belt], [comment(id("f"))], new Set())).toEqual([belt]);
  });
});

const checksResult = (snapshotId: string, drafts?: CadCheckDraft[]): CadChecksResult => ({
  revision: 0,
  snapshotId: CadSnapshotId.make(snapshotId),
  checks: ["drivetrain"],
  explanations: {},
  findings: [],
  ...(drafts ? { drafts } : {}),
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

const isPublication = Schema.is(CadCommentPublication);

describe("backstopItem", () => {
  it("never sends half an emoji in a title, label, body, or follow-up", () => {
    const part = (n: number, name: string) => ({ occurrenceId: id(n.toString(16)), name });
    // Three rollers into one bracket: the collision title passes 160 characters, and the
    // bracket's emoji sits on the cut.
    const rollers = [
      part(1, `Top Intake Roller ${"y".repeat(60)} <1>`),
      part(2, "Middle Intake Roller Compliant Wheels <1>"),
      part(3, "Bottom Intake Roller Compliant Wheels <1>"),
    ];
    const bracket = part(4, `${"z".repeat(119)}\u{1F534} Red Alliance <1>`);
    const drafts = draftCadComments(
      rollers.map(
        (roller): CadCheckFinding => ({
          check: "drivetrain",
          kind: "collision",
          problem: true,
          summary: "s",
          occurrences: [roller, bracket],
        }),
      ),
      CadSnapshotId.make("00000000-0000-4000-8000-000000000001"),
    );
    const prefix = "Top Intake Roller yyyy";
    for (let pad = 0; pad < 40; pad++) {
      const [draft] = draftCadComments(
        [rollers[0]!, ...rollers.slice(1)].map(
          (roller, i): CadCheckFinding => ({
            check: "drivetrain",
            kind: "collision",
            problem: true,
            summary: "s",
            occurrences: [
              i === 0 ? { ...roller, name: `${prefix}${"y".repeat(pad)} <1>` } : roller,
              { ...bracket, name: "Bracket \u{1F534}\u{1F534}\u{1F534}\u{1F534} <1>" },
            ],
          }),
        ),
        CadSnapshotId.make("00000000-0000-4000-8000-000000000001"),
      );
      expect(draft!.title.isWellFormed(), draft!.title).toBe(true);
    }
    for (const draft of drafts) {
      const item = backstopItem(draft);
      for (const text of [item.title, item.body, ...item.targets.map((target) => target.label)])
        expect(text.isWellFormed(), text).toBe(true);
    }
    // A name that already carries half a pair still makes a follow-up Codex can parse.
    const broken = { ...drafts[0]!, title: "Bracket \ud83d" };
    expect(followUpMessage([broken]).isWellFormed()).toBe(true);
  });

  it("publishes every kind of draft as a valid comment, even for a part named only <1>", () => {
    const part = (n: number, name: string) => ({ occurrenceId: id(n.toString(16)), name });
    const drivetrain = (
      kind: Extract<CadCheckFinding, { check: "drivetrain" }>["kind"],
      occurrences: ReturnType<typeof part>[],
    ): CadCheckFinding => ({ check: "drivetrain", kind, problem: true, summary: "s", occurrences });
    const unnamed = part(9, "<1>");
    const drafts = draftCadComments(
      [
        drivetrain("collision", [part(1, "40t Spur Gear <1>"), unnamed]),
        drivetrain("shaft-support", [
          part(2, "1.75 in. Hex Shaft <1>"),
          part(3, "40t Spur Gear <1>"),
        ]),
        drivetrain("stacked-shafts", [part(4, "13 in. Hex Shaft <1>"), part(5, "Rounded Hex <1>")]),
        {
          check: "mesh-interference",
          occurrences: [part(6, "Part 17 <2>"), part(7, "<2>")],
          intersectionVolume: 1e-4,
          intersectionFraction: 1,
          withinSubassembly: false,
          reading: "r",
        },
      ],
      CadSnapshotId.make("00000000-0000-4000-8000-000000000001"),
    );
    // Empty names pass the snapshot schema; next to a name that is only a tag, or each other,
    // their targets read the same and get their raw names back.
    const duplicate = (
      a: ReturnType<typeof part>,
      b: ReturnType<typeof part>,
    ): CadCheckFinding => ({
      check: "mesh-interference",
      occurrences: [a, b],
      intersectionVolume: 1e-4,
      intersectionFraction: 1,
      withinSubassembly: false,
      reading: "r",
    });
    const blanks = draftCadComments(
      [
        duplicate(part(10, ""), part(11, "<1>")),
        duplicate(part(12, ""), part(13, "")),
        duplicate(part(14, ""), part(15, "unnamed part <1>")),
        duplicate(part(16, "   "), part(17, "   ")),
        duplicate(part(18, "   "), part(19, "Part 4 <1>")),
      ],
      CadSnapshotId.make("00000000-0000-4000-8000-000000000001"),
    );
    expect(drafts).toHaveLength(4);
    expect(blanks).toHaveLength(5);
    for (const draft of [...drafts, ...blanks]) {
      expect(isPublication(backstopItem(draft)), draft.title).toBe(true);
      for (const target of draft.targets) expect(target.label.trim(), draft.title).not.toBe("");
      expect(draft.body, "no article without a name").not.toMatch(/\bthe (?=[ ,.)]|and\b)/i);
    }
  });

  it("keeps the note and the next step when a draft names too many parts to fit", () => {
    const shafts = Array.from({ length: 60 }, (_, i) => ({
      occurrenceId: id(i.toString(16).padStart(2, "0")),
      name: `${"Very Long Jackshaft Name ".repeat(4)}${i} <1>`,
    }));
    const [longest] = draftCadComments(
      shafts.map((shaft) => ({
        check: "drivetrain" as const,
        kind: "shaft-support" as const,
        problem: true,
        summary: "No recognized bearing.",
        occurrences: [shaft],
      })),
      CadSnapshotId.make("00000000-0000-4000-8000-000000000001"),
    );
    const body = backstopItem(longest!).body;
    expect(body.length).toBeLessThanOrEqual(4000);
    expect(body).toContain("Add a bearing where each shaft passes through a plate.");
    expect(body.endsWith(BACKSTOP_NOTE)).toBe(true);
  });
});

describe("recordCadChecks", () => {
  const first = "00000000-0000-4000-8000-000000000001";
  const later = "00000000-0000-4000-8000-000000000002";

  // Results as the checks proved them and as offered (with a point target), recorded together.
  const offeredGears: CadCheckDraft = { ...gears, title: "offered" };
  const record = (ledger: CadDraftLedger, snapshotId: string, withDrafts: boolean) =>
    recordCadChecks(
      ledger,
      checksResult(snapshotId, withDrafts ? [gears] : undefined),
      checksResult(snapshotId, withDrafts ? [offeredGears] : undefined),
    );

  it("keeps the drafts, proven and offered, when a later page on the same snapshot has none", () => {
    const ledger = makeCadDraftLedger();
    record(ledger, first, true);
    record(ledger, first, false);
    expect(ledger.drafts).toEqual([gears]);
    expect([...ledger.offered]).toEqual([["gear-spacing", offeredGears]]);
  });

  it("adds a later call's drafts on the same snapshot to the earlier ones, matched by key", () => {
    const ledger = makeCadDraftLedger();
    recordCadChecks(ledger, checksResult(first, [gears, belt]), checksResult(first, [gears, belt]));
    // A later call that ran fewer checks drafts fewer defects; the others stay.
    const regeared = { ...gears, body: "newer" };
    recordCadChecks(ledger, checksResult(first, [regeared]), checksResult(first, [regeared]));
    expect(ledger.drafts).toEqual([regeared, belt]);
    expect([...ledger.offered.keys()]).toEqual(["gear-spacing", "bare-belt"]);
  });

  it("drops drafts from an earlier snapshot once a later snapshot is checked", () => {
    const ledger = makeCadDraftLedger();
    record(ledger, first, true);
    record(ledger, later, false);
    expect(ledger.drafts).toEqual([]);
    expect(ledger.offered.size).toBe(0);
  });
});

describe("preparePublication", () => {
  it("records declines and strips them from what the comment service receives", () => {
    const ledger = makeCadDraftLedger();
    const taken = preparePublication(ledger, {
      expectedCatalogVersion: 0,
      items: [],
      declinedDrafts: [{ publicationKey: "bare-belt", explanation: "The belt is a placeholder." }],
    });
    expect(taken).toEqual({
      input: { expectedCatalogVersion: 0, items: [] },
      items: [],
      itemCount: 0,
      rejected: [],
      catalogMissing: false,
    });
    expect([...ledger.declined]).toEqual([["bare-belt", "The belt is a placeholder."]]);
  });

  it("lets a later publication by key take back an earlier decline", () => {
    const ledger = makeCadDraftLedger();
    ledger.offered = new Map([["gear-spacing", gears]]);
    preparePublication(ledger, {
      declinedDrafts: [{ publicationKey: "gear-spacing", explanation: "No comments yet." }],
    });
    const later = preparePublication(ledger, { publishDrafts: ["gear-spacing"] });
    expect(later.rejected).toEqual([]);
    expect(later.itemCount).toBe(1);
    // The decline holds until the comment service accepts the publication.
    recordPublished(ledger, later.items, {
      results: [{ publicationKey: "gear-spacing", reason: "catalog-changed" }],
    });
    expect(ledger.declined.size).toBe(1);
    recordPublished(ledger, later.items, {
      results: [{ publicationKey: "gear-spacing", commentId: "comment-1" }],
    });
    expect(ledger.declined.size).toBe(0);
    // Declining and publishing a key in one call still declines it.
    const both = preparePublication(ledger, {
      publishDrafts: ["gear-spacing"],
      declinedDrafts: [{ publicationKey: "gear-spacing", explanation: "Placeholder." }],
    });
    expect(both.rejected).toEqual([{ publicationKey: "gear-spacing", reason: "declined" }]);
  });

  it("publishes a key again with what the comment service first accepted for it", () => {
    const ledger = makeCadDraftLedger();
    ledger.offered = new Map([["gear-spacing", gears]]);
    const first = preparePublication(ledger, { publishDrafts: ["gear-spacing"] });
    recordPublished(ledger, first.items, {
      results: [{ publicationKey: "gear-spacing", commentId: "comment-1" }],
    });
    // A later cad_checks call offers the draft with other targets.
    ledger.offered = new Map([["gear-spacing", { ...gears, title: "re-placed" }]]);
    const again = preparePublication(ledger, { publishDrafts: ["gear-spacing"] });
    expect(again.input).toMatchObject({ items: [gears] });
  });

  it("replays the agent's own wording of a draft, and never a rejected publication", () => {
    const ledger = makeCadDraftLedger();
    ledger.offered = new Map([
      ["gear-spacing", gears],
      ["bare-belt", belt],
    ]);
    const reworded = { ...gears, title: "Move the 40T gear out" };
    recordPublished(ledger, [reworded, belt], {
      results: [
        { publicationKey: "gear-spacing", commentId: "comment-1" },
        { publicationKey: "bare-belt", reason: "invalid-input" },
      ],
    });
    const again = preparePublication(ledger, { publishDrafts: ["gear-spacing", "bare-belt"] });
    expect(again.input).toMatchObject({ items: [reworded, belt] });
    expect([...ledger.sent.keys()]).toEqual(["gear-spacing"]);
  });

  it("fills the catalog version only when the agent sends no items of its own", () => {
    const ledger = makeCadDraftLedger();
    expect(preparePublication(ledger, { publishDrafts: ["gear-spacing"] }).catalogMissing).toBe(
      true,
    );
    // The version guards the agent's own items against a catalog that changed under it.
    expect(preparePublication(ledger, { items: [{ publicationKey: "mine" }] }).catalogMissing).toBe(
      false,
    );
  });
});

describe("settleDrafts", () => {
  it.effect("publishes more than 20 leftover drafts in batches", () =>
    Effect.gen(function* () {
      const ledger = makeCadDraftLedger();
      ledger.drafts = Array.from({ length: 21 }, (_, i) => draft(`draft-${i}`, id(i.toString(16))));
      const batches: number[] = [];
      const comments: NonNullable<CadAgentTools["comments"]> = (name, input) =>
        Effect.sync(() => {
          if (name === "cad_comments_publish")
            batches.push((input as { items: unknown[] }).items.length);
          return { result: { comments: [], catalogVersion: batches.length, nextCursor: null } };
        });
      // Only the comment tool is read; the rest of the activation is unused here.
      yield* settleDrafts({ comments } as CadAgentTools, ledger);
      expect(batches).toEqual([20, 1]);
    }),
  );
});
