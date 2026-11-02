/**
 * ProjectionThreadMessageRepository - Projection repository interface for messages.
 *
 * Owns persistence operations for projected thread messages rendered in the
 * orchestration read model.
 *
 * @module ProjectionThreadMessageRepository
 */
import {
  ChatAttachment,
  MessageId,
  MessageRating,
  OrchestrationMessageRole,
  ThreadId,
  TurnId,
  IsoDateTime,
} from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadMessage = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  isStreaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadMessage = typeof ProjectionThreadMessage.Type;

export const ListProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadMessagesInput = typeof ListProjectionThreadMessagesInput.Type;

export const GetProjectionThreadMessageInput = Schema.Struct({
  messageId: MessageId,
});
export type GetProjectionThreadMessageInput = typeof GetProjectionThreadMessageInput.Type;

export const SetProjectionThreadMessageRatingInput = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  // Encoded to the rating_json column; null clears it.
  rating: Schema.NullOr(Schema.fromJsonString(MessageRating)),
});
export type SetProjectionThreadMessageRatingInput =
  typeof SetProjectionThreadMessageRatingInput.Type;

export const DeleteProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadMessagesInput = typeof DeleteProjectionThreadMessagesInput.Type;

/**
 * ProjectionThreadMessageRepositoryShape - Service API for projected thread messages.
 */
export interface ProjectionThreadMessageRepositoryShape {
  /**
   * Insert or replace a projected thread message row.
   *
   * Upserts by `messageId`.
   */
  readonly upsert: (
    message: ProjectionThreadMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread message by id.
   */
  readonly getByMessageId: (
    input: GetProjectionThreadMessageInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * List projected thread messages for a thread.
   *
   * Returned in ascending creation order.
   */
  readonly listByThreadId: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * Set or clear the user's rating on a projected message. `upsert` never
   * writes the rating, so later message updates keep it.
   */
  readonly setRating: (
    input: SetProjectionThreadMessageRatingInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Delete projected thread messages by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadMessageRepository - Service tag for message projection persistence.
 */
export class ProjectionThreadMessageRepository extends Context.Service<
  ProjectionThreadMessageRepository,
  ProjectionThreadMessageRepositoryShape
>()(
  "@cadsense/server/persistence/Services/ProjectionThreadMessages/ProjectionThreadMessageRepository",
) {}
