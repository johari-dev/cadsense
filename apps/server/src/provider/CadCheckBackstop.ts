import type { CadCheckDraft, CadChecksResult } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CAD_DRAFT_DECLINE_RULE } from "../cad/CadChecks.ts";
import { clip } from "../cad/CadDrivetrain.ts";
import type { CadAgentTools } from "../cad/CadViewing.ts";
import { type CadPlacementCache, makeCadPlacementCache } from "./CadCheckPlacement.ts";

/**
 * Drafts that still need a comment: not declined by the agent, and no comment in the chat targets
 * any of their parts. Matching by part errs toward treating a draft as covered, so a model that
 * comments on everything gets no backstop comments. See "Drafts, reminders, and the backstop" in
 * cad/CadChecks.md.
 */
export const uncoveredDrafts = (
  drafts: readonly CadCheckDraft[],
  comments: ReadonlyArray<{ readonly targets: ReadonlyArray<{ readonly occurrenceId: string }> }>,
  declined: ReadonlySet<string>,
): CadCheckDraft[] => {
  const commented = new Set(
    comments.flatMap((comment) => comment.targets.map((target) => target.occurrenceId)),
  );
  return drafts.filter(
    (draft) =>
      !declined.has(draft.publicationKey) && !draftParts(draft).some((id) => commented.has(id)),
  );
};

/** Parts a draft is about: its whole-part targets and the part its check-placed marker sits on. */
const draftParts = (draft: CadCheckDraft) => [
  ...draft.targets.flatMap((target) => (target.kind === "part" ? [target.occurrenceId] : [])),
  ...(draft.placements ?? []).map((placement) => placement.occurrenceId),
];

/**
 * The whole-part item the backstop publishes for a draft. A check-placed point is never published
 * this way: no agent has looked at its inspection image.
 */
export const backstopItem = (draft: CadCheckDraft) => {
  const { placements: _placements, ...item } = draft;
  return {
    ...item,
    targets: item.targets.filter((target) => target.kind === "part"),
    // Drafts leave room for the note; a body that does not still keeps the whole note.
    body: `${clip(item.body, 4000 - BACKSTOP_NOTE.length - 1)} ${BACKSTOP_NOTE}`,
  };
};

/** Appended to a backstop comment so the student knows a check wrote it, not the review. */
export const BACKSTOP_NOTE = "(Found by Cadsense's automatic checks.)";

/**
 * One activation's drafts: as cad_checks proved them (`drafts`, with whole-part targets, for coverage
 * and the backstop), as offered to the agent (`offered`, with any inspected point targets, for
 * publishing by key), the markers placed for them (`placements`), the ones its agent declined, what
 * each key was first published with (`sent`), the keys still uncovered (`pending`), and whether the
 * follow-up was sent.
 */
export interface CadDraftLedger {
  drafts: readonly CadCheckDraft[];
  offered: ReadonlyMap<string, CadCheckDraft>;
  readonly placements: CadPlacementCache;
  readonly declined: Map<string, string>;
  readonly sent: Map<string, unknown>;
  pending: readonly string[];
  followedUp: boolean;
  settled: boolean;
}
/**
 * `declined` and `sent` are shared by the main agent's turns in a session: draft keys repeat on one
 * snapshot, and a key published again must carry what it was first published with.
 */
export const makeCadDraftLedger = (
  session: {
    readonly declined: Map<string, string>;
    readonly sent: Map<string, unknown>;
  } = { declined: new Map(), sent: new Map() },
): CadDraftLedger => ({
  drafts: [],
  offered: new Map(),
  placements: makeCadPlacementCache(),
  declined: session.declined,
  sent: session.sent,
  pending: [],
  followedUp: false,
  settled: false,
});

/**
 * Remembers the drafts from a cad_checks result, as the checks proved them (`proven`) and as
 * placeCadDrafts offered them to the agent (`offered`). On the snapshot already recorded, a
 * result's drafts add to the earlier ones and replace those with the same key: a later call may
 * run fewer checks, or be a later page with no drafts, and the defects it did not reproduce are
 * still in the model. A result for another snapshot starts over: drafts must never be published
 * against a newer model than they describe.
 */
export const recordCadChecks = (
  ledger: CadDraftLedger,
  proven: CadChecksResult,
  offered: CadChecksResult,
) => {
  const same = ledger.drafts[0]?.inspectedSnapshotId === proven.snapshotId;
  const byKey = (drafts: readonly CadCheckDraft[] = []) =>
    drafts.map((draft) => [draft.publicationKey, draft] as const);
  ledger.drafts = [
    ...new Map([...(same ? byKey(ledger.drafts) : []), ...byKey(proven.drafts)]).values(),
  ];
  ledger.offered = new Map([...(same ? ledger.offered : []), ...byKey(offered.drafts)]);
};

const PublishExtras = Schema.Struct({
  expectedCatalogVersion: Schema.optionalKey(Schema.Int),
  items: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  declinedDrafts: Schema.optionalKey(
    Schema.Array(Schema.Struct({ publicationKey: Schema.String, explanation: Schema.String })),
  ),
  publishDrafts: Schema.optionalKey(Schema.Array(Schema.String)),
});
const decodeExtras = Schema.decodeUnknownOption(PublishExtras);
const keyOf = (item: unknown) =>
  typeof item === "object" && item !== null && "publicationKey" in item
    ? item.publicationKey
    : undefined;
/**
 * Turns a cad_comments_publish input into what the comment service takes, which knows nothing of
 * drafts: records `declinedDrafts`, expands `publishDrafts` into the drafts as offered, and drops
 * both fields. A key published before goes out with what was first accepted for it, so it replays
 * (see recordPublished). A key declined in an earlier call may be published, which takes the decline
 * back once accepted; a key that is unknown or declined in the same call is reported in `rejected`
 * and not published; a key the agent also sent as an item publishes once, as the agent's item. `catalogMissing` asks the
 * caller to fill `expectedCatalogVersion`, only for a publication with no items of the agent's own.
 * `items` are the items forwarded, for recordPublished.
 * `itemCount` is null when the input is malformed, so the
 * comment service reports the error.
 */
export const preparePublication = (ledger: CadDraftLedger, input: unknown) => {
  const parsed = decodeExtras(input);
  if (Option.isNone(parsed) || typeof input !== "object" || input === null)
    return { input, items: [], itemCount: null, rejected: [], catalogMissing: false };
  const declinedNow = new Set<string>();
  for (const decline of parsed.value.declinedDrafts ?? []) {
    ledger.declined.set(decline.publicationKey, decline.explanation);
    declinedNow.add(decline.publicationKey);
  }
  const items = parsed.value.items ?? [];
  const sent = new Set(items.map(keyOf));
  const rejected: { publicationKey: string; reason: string }[] = [];
  const fromDrafts: unknown[] = [];
  for (const key of new Set(parsed.value.publishDrafts ?? [])) {
    if (sent.has(key)) continue;
    const draft = ledger.sent.get(key) ?? ledger.offered.get(key);
    if (declinedNow.has(key)) rejected.push({ publicationKey: key, reason: "declined" });
    else if (!draft) rejected.push({ publicationKey: key, reason: "unknown-draft" });
    else fromDrafts.push(draft);
  }
  const rest = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "declinedDrafts" && key !== "publishDrafts"),
  );
  const forwarded = { ...rest, items: [...items, ...fromDrafts] };
  return {
    input: forwarded,
    items: forwarded.items,
    itemCount: forwarded.items.length,
    rejected,
    // Only a publication of drafts alone gets the current version: for the agent's own items the
    // version guards against a catalog that changed under it.
    catalogMissing: parsed.value.expectedCatalogVersion === undefined && items.length === 0,
  };
};

const AcceptedResults = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      publicationKey: Schema.String,
      commentId: Schema.optionalKey(Schema.String),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeAccepted = Schema.decodeUnknownOption(AcceptedResults);
/**
 * After a publication, remembers what the comment service accepted for each draft key, the agent's
 * own wording or the draft as offered, so publishing the key again replays it instead of
 * conflicting, and takes back any decline of an accepted key. A rejected item changes nothing.
 */
export const recordPublished = (
  ledger: CadDraftLedger,
  items: readonly unknown[],
  result: unknown,
) => {
  const parsed = decodeAccepted(result);
  if (Option.isNone(parsed)) return;
  const accepted = new Set(
    parsed.value.results
      .filter((entry) => entry.commentId !== undefined && entry.reason === undefined)
      .map((entry) => entry.publicationKey),
  );
  for (const item of items) {
    const key = keyOf(item);
    if (typeof key !== "string" || !accepted.has(key)) continue;
    ledger.declined.delete(key);
    if (
      !ledger.sent.has(key) &&
      (ledger.offered.has(key) || ledger.drafts.some((draft) => draft.publicationKey === key))
    )
      ledger.sent.set(key, item);
  }
};

/** The chat's current comment catalog version, for a publication that left it out. */
export const currentCatalogVersion = Effect.fn("CadCheckBackstop.currentCatalogVersion")(function* (
  tools: CadAgentTools,
) {
  return (yield* chatComments(tools))?.catalogVersion ?? 0;
});

const CommentPage = Schema.Struct({
  comments: Schema.Array(
    Schema.Struct({ targets: Schema.Array(Schema.Struct({ occurrenceId: Schema.String })) }),
  ),
  catalogVersion: Schema.Int,
  nextCursor: Schema.NullOr(Schema.String),
});
const decodePage = Schema.decodeUnknownEffect(CommentPage);
/** Every comment in the activation's chat, with the catalog version a publication must expect. */
const chatComments = Effect.fn("CadCheckBackstop.chatComments")(function* (tools: CadAgentTools) {
  const comments: (typeof CommentPage.Type)["comments"][number][] = [];
  let catalogVersion = 0;
  let cursor: string | null = null;
  do {
    if (!tools.comments) return null;
    const delivery: { readonly result: unknown } = yield* tools.comments("cad_comments_list", {
      limit: 100,
      ...(cursor === null ? {} : { cursor }),
    });
    const page: typeof CommentPage.Type = yield* decodePage(delivery.result);
    comments.push(...page.comments);
    catalogVersion = page.catalogVersion;
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { comments, catalogVersion };
});

/** The drafts no comment covers and the agent has not declined, for the reminder and the backstop. */
export const remainingDrafts = Effect.fn("CadCheckBackstop.remainingDrafts")(function* (
  tools: CadAgentTools,
  ledger: CadDraftLedger,
) {
  if (ledger.drafts.length === 0) return [];
  const chat = yield* chatComments(tools);
  return chat ? uncoveredDrafts(ledger.drafts, chat.comments, new Set(ledger.declined.keys())) : [];
});

/** What the reminder shows the agent: enough to find each draft, not the full item again. */
export const presentRemaining = (drafts: readonly CadCheckDraft[], note: string) =>
  drafts.length === 0
    ? {}
    : {
        remainingDrafts: drafts.map(({ publicationKey, title, targets }) => ({
          publicationKey,
          title,
          parts: targets.map((target) => target.label),
        })),
        remainingDraftsNote: note,
      };

/**
 * The turn-end backstop: publishes every draft that no comment covers and the agent did not
 * decline, worded as drafted with BACKSTOP_NOTE appended, in batches of 20. Runs once per
 * activation, and only when armed; see makeCadProviderTools.
 */
export const settleDrafts = Effect.fn("CadCheckBackstop.settleDrafts")(function* (
  tools: CadAgentTools,
  ledger: CadDraftLedger,
) {
  if (ledger.settled || ledger.drafts.length === 0 || !tools.comments) return;
  ledger.settled = true;
  const chat = yield* chatComments(tools);
  if (!chat) return;
  const uncovered = uncoveredDrafts(ledger.drafts, chat.comments, new Set(ledger.declined.keys()));
  // One publication takes at most 20 items; each batch expects the catalog the last one left.
  let catalogVersion = chat.catalogVersion;
  for (let start = 0; start < uncovered.length; start += 20) {
    if (start > 0) catalogVersion = yield* currentCatalogVersion(tools);
    const items = uncovered.slice(start, start + 20).map(backstopItem);
    const delivery = yield* tools.comments("cad_comments_publish", {
      expectedCatalogVersion: catalogVersion,
      items,
    });
    recordPublished(ledger, items, delivery.result);
    yield* Effect.logInfo("CAD check backstop published drafts", {
      drafts: uncovered.slice(start, start + 20).map((draft) => draft.publicationKey),
      result: delivery.result,
    });
  }
});

/**
 * The message that sends an agent back to the drafts it left uncovered when it tried to end its turn.
 * See "The follow-up" in cad/CadChecks.md.
 */
export const followUpMessage = (drafts: readonly CadCheckDraft[]) =>
  [
    `Before you finish: Cadsense's checks proved ${drafts.length === 1 ? "a defect that has" : `${drafts.length} defects that have`} no CAD comment and that you have not declined:`,
    ...drafts.map((draft) => `- ${draft.title} (cad_checks draft ${draft.publicationKey})`),
    "Publish each one with cad_comments_publish, using publishDrafts or your own wording, or decline it in the same call.",
    CAD_DRAFT_DECLINE_RULE,
    "Drafts you neither publish nor decline are published as drafted when this turn ends.",
    "If you added comments, tell the student in one short sentence what you added, in their terms, without mentioning drafts or tools.",
  ]
    .join("\n")
    // Sent as a turn's input, where a lone surrogate from a part name would break the JSON.
    .toWellFormed();

/** The note other CAD tool results carry while drafts are uncovered and undeclined. */
export const presentPending = (pending: readonly string[]) =>
  pending.length === 0
    ? {}
    : {
        pendingDrafts: {
          count: pending.length,
          publicationKeys: pending,
          note: "Proven defects from cad_checks with no comment yet. Publish them with cad_comments_publish {publishDrafts:[...keys]} (or your own wording), or decline them with a reason. Leftovers are published as drafted when the turn ends.",
        },
      };
