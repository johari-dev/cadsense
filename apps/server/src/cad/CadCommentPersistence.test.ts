import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CAD_REVIEW_LEARNINGS_LIMIT,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { projectCadCommentEvent, readProjectCadReviewLearnings } from "./CadCommentPersistence.ts";

const now = "2026-09-05T00:00:00Z";
const projectId = ProjectId.make("learnings-project");
const otherProjectId = ProjectId.make("other-project");
const base = (sequence: number, aggregateId: ProjectId) => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "project" as const,
  aggregateId,
  occurredAt: now,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});
const added = (sequence: number, owner = projectId): OrchestrationEvent => ({
  ...base(sequence, owner),
  type: "project.cad-review-learning-added",
  payload: {
    projectId: owner,
    learning: {
      id: `learning-${sequence}`,
      projectId: owner,
      text: `Learning ${sequence}`,
      sourceCommentId: "comment",
      sourceThreadId: ThreadId.make("thread"),
      createdAt: now,
    },
  },
});
const removed = (sequence: number, learningId: string, owner = projectId): OrchestrationEvent => ({
  ...base(sequence, owner),
  type: "project.cad-review-learning-removed",
  payload: { projectId: owner, learningId },
});
const layer = SqlitePersistenceMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cadsense-cad-learnings-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("keeps the newest learnings per project and removes only the addressed row", () =>
  Effect.gen(function* () {
    const ids = (owner: ProjectId) =>
      readProjectCadReviewLearnings(owner).pipe(Effect.map((rows) => rows.map((row) => row.id)));
    for (let sequence = 1; sequence <= CAD_REVIEW_LEARNINGS_LIMIT + 2; sequence++)
      yield* projectCadCommentEvent(added(sequence));
    yield* projectCadCommentEvent(added(900, otherProjectId));
    const kept = yield* ids(projectId);
    assert.equal(kept.length, CAD_REVIEW_LEARNINGS_LIMIT);
    assert.equal(kept[0], "learning-3");
    assert.equal(kept.at(-1), `learning-${CAD_REVIEW_LEARNINGS_LIMIT + 2}`);
    assert.deepEqual(yield* ids(otherProjectId), ["learning-900"]);
    // Replaying a projected event changes nothing.
    yield* projectCadCommentEvent(added(CAD_REVIEW_LEARNINGS_LIMIT + 2));
    assert.deepEqual(yield* ids(projectId), kept);
    yield* projectCadCommentEvent(removed(901, "learning-3"));
    assert.deepEqual(yield* ids(projectId), kept.slice(1));
    // A removal naming the wrong project leaves the row alone.
    yield* projectCadCommentEvent(removed(902, "learning-4", otherProjectId));
    assert.include(yield* ids(projectId), "learning-4");
  }).pipe(Effect.provide(layer)),
);
