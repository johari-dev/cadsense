import { CadSnapshotId, type CadCheckDraft, type CadChecksResult } from "@cadsense/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  type CadDraftLedger,
  makeCadDraftLedger,
  recordCadChecks,
  preparePublication,
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
});
