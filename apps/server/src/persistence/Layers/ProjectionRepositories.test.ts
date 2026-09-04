import {
  OnshapeConnectionId,
  OnshapeDocumentId,
  OnshapeElementId,
  OnshapeProjectSource,
  OnshapeWorkspaceId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  onshapeProjectSourceIdentity,
} from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.make("project-null-options"),
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        onshapeSource: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_projects row to exist.");
      }

      assert.strictEqual(
        row.defaultModelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* projects.getById({
        projectId: ProjectId.make("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-null-options"),
        projectId: ProjectId.make("project-null-options"),
        title: "Null options thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        pinnedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_threads row to exist.");
      }

      assert.strictEqual(
        row.modelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      });
    }),
  );

  it.effect("round-trips Onshape source metadata and stores its stable identity", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;
      const source = OnshapeProjectSource.make({
        connectionId: OnshapeConnectionId.make("00000000-0000-4000-8000-000000000001"),
        host: "https://cad.onshape.com",
        documentId: OnshapeDocumentId.make("05760c4d8b40fba37db8fa48"),
        workspaceType: "w",
        workspaceId: OnshapeWorkspaceId.make("f31b499c519e8471cced93dc"),
        elementId: OnshapeElementId.make("b53dde24ab8b46d679af9944"),
        configuration: "Size=Large",
      });

      yield* projects.upsert({
        projectId: ProjectId.make("project-onshape-source"),
        title: "Onshape project",
        workspaceRoot: "/tmp/project-onshape-source",
        defaultModelSelection: null,
        onshapeSource: source,
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly onshapeSource: string | null;
        readonly onshapeSourceKey: string | null;
      }>`
        SELECT
          onshape_source_json AS "onshapeSource",
          onshape_source_key AS "onshapeSourceKey"
        FROM projection_projects
        WHERE project_id = 'project-onshape-source'
      `;
      assert.strictEqual(rows[0]?.onshapeSourceKey, onshapeProjectSourceIdentity(source));

      const persisted = yield* projects.getById({
        projectId: ProjectId.make("project-onshape-source"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.onshapeSource, source);
    }),
  );
});
