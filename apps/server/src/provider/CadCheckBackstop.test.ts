import { CadSnapshotId, type CadCheckDraft, type CadChecksResult } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import type { CadAgentTools } from "../cad/CadViewing.ts";
import {
  type CadDraftLedger,
  makeCadDraftLedger,
  recordCadChecks,
  preparePublication,
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
    expect(ledger.declined.size).toBe(0);
    // Declining and publishing a key in one call still declines it.
    const both = preparePublication(ledger, {
      publishDrafts: ["gear-spacing"],
      declinedDrafts: [{ publicationKey: "gear-spacing", explanation: "Placeholder." }],
    });
    expect(both.rejected).toEqual([{ publicationKey: "gear-spacing", reason: "declined" }]);
  });

  it("publishes a key again with the content it was first sent with", () => {
    const ledger = makeCadDraftLedger();
    ledger.offered = new Map([["gear-spacing", gears]]);
    preparePublication(ledger, { publishDrafts: ["gear-spacing"] });
    // A later cad_checks call offers the draft with other targets.
    ledger.offered = new Map([["gear-spacing", { ...gears, title: "re-placed" }]]);
    const again = preparePublication(ledger, { publishDrafts: ["gear-spacing"] });
    expect(again.input).toMatchObject({ items: [gears] });
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
