import type { OnshapeProjectSource } from "@cadsense/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const MAX_AGE_MS = 2 * 60_000;
const MAX_ENTRIES = 32;

/**
 * The element list that catalog discovery last read for each Onshape workspace. A first sync
 * right after discovery records it as its element fingerprint instead of reading it again.
 * Held in memory only: losing an entry costs that one read.
 */
export class OnshapeRecentElements extends Context.Service<
  OnshapeRecentElements,
  {
    readonly remember: (source: OnshapeProjectSource, elements: unknown) => Effect.Effect<void>;
    /** Removes the workspace's entry and returns it when it was read in the last two minutes. */
    readonly take: (source: OnshapeProjectSource) => Effect.Effect<Option.Option<unknown>>;
  }
>()("@cadsense/server/onshape/OnshapeRecentElements") {}

const workspaceKey = (source: OnshapeProjectSource) =>
  [source.host, source.documentId, source.workspaceType, source.workspaceId].join("\0");

export const make = Effect.sync(() => {
  const entries = new Map<string, { readonly elements: unknown; readonly readAt: number }>();
  return OnshapeRecentElements.of({
    remember: (source, elements) =>
      Effect.map(Clock.currentTimeMillis, (readAt) => {
        const key = workspaceKey(source);
        entries.delete(key);
        entries.set(key, { elements, readAt });
        // Maps iterate in insertion order, so the first key is the oldest entry.
        if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
      }),
    take: (source) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const key = workspaceKey(source);
        const entry = entries.get(key);
        entries.delete(key);
        return entry && now - entry.readAt <= MAX_AGE_MS
          ? Option.some(entry.elements)
          : Option.none();
      }),
  });
});

export const layer = Layer.effect(OnshapeRecentElements, make);
