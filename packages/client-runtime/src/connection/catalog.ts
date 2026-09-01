import { EnvironmentId } from "@cadsense/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { BearerConnectionTarget, PrimaryConnectionTarget, type ConnectionTarget } from "./model.ts";

export class BearerConnectionProfile extends Schema.TaggedClass<BearerConnectionProfile>()(
  "BearerConnectionProfile",
  {
    connectionId: Schema.String,
    environmentId: EnvironmentId,
    label: Schema.String,
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
  },
) {}

export class BearerConnectionCredential extends Schema.TaggedClass<BearerConnectionCredential>()(
  "BearerConnectionCredential",
  { token: Schema.String },
) {}

export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<BearerConnectionProfile>;
  readonly credential?: Option.Option<BearerConnectionCredential>;
}

export class PrimaryConnectionRegistration extends Schema.TaggedClass<PrimaryConnectionRegistration>()(
  "PrimaryConnectionRegistration",
  { target: PrimaryConnectionTarget },
) {}

export class BearerConnectionRegistration extends Schema.TaggedClass<BearerConnectionRegistration>()(
  "BearerConnectionRegistration",
  {
    target: BearerConnectionTarget,
    profile: BearerConnectionProfile,
    credential: BearerConnectionCredential,
  },
) {}

export const PlatformConnectionRegistration = Schema.Union([
  PrimaryConnectionRegistration,
  BearerConnectionRegistration,
]);
export type PlatformConnectionRegistration = typeof PlatformConnectionRegistration.Type;

export function connectionRegistrationCatalogEntry(
  registration: PlatformConnectionRegistration,
): ConnectionCatalogEntry {
  switch (registration._tag) {
    case "PrimaryConnectionRegistration":
      return { target: registration.target, profile: Option.none(), credential: Option.none() };
    case "BearerConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.some(registration.profile),
        credential: Option.some(registration.credential),
      };
  }
}
