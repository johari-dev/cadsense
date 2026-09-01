import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId } from "@cadsense/contracts";
import { createModelSelection } from "@cadsense/shared/model";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"],
): ProviderInstance =>
  ({
    instanceId,
    driverKind: instanceId as unknown as ProviderInstance["driverKind"],
    continuationIdentity: {
      driverKind: instanceId as unknown as ProviderInstance["driverKind"],
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: TextGeneration.TextGeneration.of({ generateThreadTitle }),
  }) satisfies ProviderInstance;

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistry.ProviderInstanceRegistry["Service"] => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
  };
};

describe("makeTextGenerationFromRegistry", () => {
  it.effect("delegates title generation to the selected provider instance", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("personal");
      const messages: string[] = [];
      const instance = makeStubInstance(instanceId, (input) => {
        messages.push(input.message);
        return Effect.succeed({ title: "Refactor routing" });
      });
      const service = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));

      const result = yield* service.generateThreadTitle({
        cwd: process.cwd(),
        message: "Refactor the routing layer",
        modelSelection: createModelSelection(instanceId, "test-model"),
      });

      expect(result).toEqual({ title: "Refactor routing" });
      expect(messages).toEqual(["Refactor the routing layer"]);
    }),
  );

  it.effect("returns a typed error for an unknown provider instance", () =>
    Effect.gen(function* () {
      const service = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([]));
      const result = yield* service
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "Name this thread",
          modelSelection: createModelSelection(ProviderInstanceId.make("missing"), "test-model"),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ThreadTitleGenerationError");
        expect(result.failure.operation).toBe("generateThreadTitle");
        expect(result.failure.detail).toContain("missing");
      }
    }),
  );
});
