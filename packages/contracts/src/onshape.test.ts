import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  MAX_ONSHAPE_ACCESS_KEY_ID_LENGTH,
  MAX_ONSHAPE_CONNECTION_HOST_LENGTH,
  MAX_ONSHAPE_CONNECTION_NAME_LENGTH,
  MAX_ONSHAPE_RETRY_AFTER_SECONDS,
  MAX_ONSHAPE_SECRET_KEY_LENGTH,
  OnshapeConnectionCreateInput,
  OnshapeConnectionError,
  OnshapeConnectionId,
  OnshapeConnectionListResult,
  OnshapeConnectionRenameInput,
  OnshapeConnectionReplaceCredentialsInput,
  OnshapeConnectionSummary,
  OnshapeInsufficientPermissionsError,
  OnshapeRateLimitError,
  OnshapeRedirectError,
  OnshapeVerificationThrottledError,
  onshapeStackOrigin,
} from "./onshape.ts";

const decodeCreateInput = Schema.decodeUnknownSync(OnshapeConnectionCreateInput);
const decodeRenameInput = Schema.decodeUnknownSync(OnshapeConnectionRenameInput);
const decodeReplaceCredentialsInput = Schema.decodeUnknownSync(
  OnshapeConnectionReplaceCredentialsInput,
);
const decodeConnectionSummary = Schema.decodeUnknownSync(OnshapeConnectionSummary);
const decodeConnectionListResult = Schema.decodeUnknownSync(OnshapeConnectionListResult);
const decodeConnectionError = Schema.decodeUnknownSync(OnshapeConnectionError);
const decodeConnectionId = Schema.decodeUnknownSync(OnshapeConnectionId);

describe("Onshape connection contracts", () => {
  it("keeps credentials on write inputs and strips them from public summaries", () => {
    const credentials = decodeCreateInput({
      name: " Competition CAD ",
      host: " https://cad.onshape.com ",
      accessKeyId: "access-key",
      secretKey: "secret-key",
    });
    expect(credentials).toEqual({
      name: "Competition CAD",
      host: "https://cad.onshape.com",
      accessKeyId: "access-key",
      secretKey: "secret-key",
    });

    const summary = decodeConnectionSummary({
      connectionId: "00000000-0000-4000-8000-000000000001",
      name: "Competition CAD",
      host: "https://cad.onshape.com",
      verifiedAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
      accessKeyId: "must-not-cross-the-wire",
      secretKey: "must-not-cross-the-wire",
    });
    expect(summary).toEqual({
      connectionId: "00000000-0000-4000-8000-000000000001",
      name: "Competition CAD",
      host: "https://cad.onshape.com",
      verifiedAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
    });
    expect(JSON.stringify(summary)).not.toContain("must-not-cross-the-wire");
  });

  it("decodes only redacted connection summaries in list results", () => {
    const result = decodeConnectionListResult({
      catalogUpdatedAt: "2026-09-04T00:00:00.000Z",
      connections: [
        {
          connectionId: "00000000-0000-4000-8000-000000000001",
          name: "Competition CAD",
          host: "https://cad.onshape.com",
          verifiedAt: "2026-09-04T00:00:00.000Z",
          updatedAt: "2026-09-04T00:00:00.000Z",
          secretKey: "must-not-cross-the-wire",
        },
      ],
    });

    expect(result.connections).toEqual([
      {
        connectionId: "00000000-0000-4000-8000-000000000001",
        name: "Competition CAD",
        host: "https://cad.onshape.com",
        verifiedAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
      },
    ]);
    expect(result.catalogUpdatedAt).toBe("2026-09-04T00:00:00.000Z");
  });

  it("rejects oversized connection names, hosts, and credentials", () => {
    const connectionId = "00000000-0000-4000-8000-000000000001";
    const validInput = {
      name: "Competition CAD",
      host: "https://cad.onshape.com",
      accessKeyId: "access-key",
      secretKey: "secret-key",
    };

    expect(() =>
      decodeCreateInput({
        ...validInput,
        name: "n".repeat(MAX_ONSHAPE_CONNECTION_NAME_LENGTH + 1),
      }),
    ).toThrow();
    expect(() =>
      decodeRenameInput({
        connectionId,
        name: "n".repeat(MAX_ONSHAPE_CONNECTION_NAME_LENGTH + 1),
      }),
    ).toThrow();
    expect(() =>
      decodeCreateInput({
        ...validInput,
        host: "h".repeat(MAX_ONSHAPE_CONNECTION_HOST_LENGTH + 1),
      }),
    ).toThrow();
    expect(() =>
      decodeReplaceCredentialsInput({
        connectionId,
        ...validInput,
        accessKeyId: "a".repeat(MAX_ONSHAPE_ACCESS_KEY_ID_LENGTH + 1),
      }),
    ).toThrow();
    expect(() =>
      decodeReplaceCredentialsInput({
        connectionId,
        ...validInput,
        secretKey: "s".repeat(MAX_ONSHAPE_SECRET_KEY_LENGTH + 1),
      }),
    ).toThrow();
  });

  it("keeps rate-limit details bounded and safe", () => {
    const error = decodeConnectionError({
      _tag: "OnshapeRateLimitError",
      retryAfterSeconds: 45,
      responseBody: "authorization=secret-value",
    });

    expect(error).toEqual(new OnshapeRateLimitError({ retryAfterSeconds: 45 }));
    expect(error.message).toBe("Onshape is rate limiting requests. Try again in 45 seconds.");
    expect(JSON.stringify(error)).not.toContain("secret-value");
    expect(() =>
      decodeConnectionError({
        _tag: "OnshapeRateLimitError",
        retryAfterSeconds: MAX_ONSHAPE_RETRY_AFTER_SECONDS + 1,
      }),
    ).toThrow();
  });

  it("exposes safe permission, redirect, and verification-throttle failures", () => {
    const insufficientPermissions = decodeConnectionError({
      _tag: "OnshapeInsufficientPermissionsError",
      responseBody: "authorization=secret-value",
    });
    const redirect = decodeConnectionError({
      _tag: "OnshapeRedirectError",
      location: "https://credentials.example/secret-value",
    });
    const throttled = decodeConnectionError({
      _tag: "OnshapeVerificationThrottledError",
      retryAfterSeconds: 30,
      request: "secret-value",
    });

    expect(insufficientPermissions).toEqual(new OnshapeInsufficientPermissionsError());
    expect(redirect).toEqual(new OnshapeRedirectError());
    expect(throttled).toEqual(new OnshapeVerificationThrottledError({ retryAfterSeconds: 30 }));
    expect(throttled.message).toBe(
      "Connection verification is temporarily throttled. Try again in 30 seconds.",
    );
    expect(JSON.stringify({ insufficientPermissions, redirect, throttled })).not.toContain(
      "secret-value",
    );
    expect(() =>
      decodeConnectionError({
        _tag: "OnshapeVerificationThrottledError",
        retryAfterSeconds: MAX_ONSHAPE_RETRY_AFTER_SECONDS + 1,
      }),
    ).toThrow();
  });

  it("brands stable environment-local connection ids", () => {
    expect(OnshapeConnectionId.make("00000000-0000-4000-8000-000000000001")).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(() => decodeConnectionId("../../unsafe-secret-path")).toThrow();
  });
});

describe("onshapeStackOrigin", () => {
  const stackOf = (link: string) => onshapeStackOrigin(new URL(link));

  // Each of these served the same public document as cad.onshape.com when probed.
  it("reads public stack aliases as cad.onshape.com", () => {
    for (const host of [
      "cad.onshape.com",
      "onshape.com",
      "www.onshape.com",
      "WWW.Onshape.com",
      "oauth.onshape.com",
      "api.onshape.com",
      "cad-usw2.onshape.com",
      "cad-euw1.onshape.com",
      "cad-aps1.onshape.com",
      "cad-aps2.onshape.com",
      "cad-apn1.onshape.com",
    ]) {
      expect(stackOf(`https://${host}/documents/x`), host).toBe("https://cad.onshape.com");
    }
  });

  it("keeps enterprise domains and separate stacks as their own origin", () => {
    for (const host of [
      "1678.onshape.com",
      "team.example.onshape.com",
      "cad.usgov.onshape.com",
      "partner.dev.onshape.com",
      "cad-euw1.dev.onshape.com",
    ]) {
      expect(stackOf(`https://${host}/documents/x`), host).toBe(`https://${host}`);
    }
  });

  it("rejects links that are not https on onshape.com", () => {
    for (const link of [
      "https://cad.onshape.com.attacker.example/documents/x",
      "https://notonshape.com/documents/x",
      "http://cad.onshape.com/documents/x",
      "https://cad.onshape.com:8443/documents/x",
    ]) {
      expect(stackOf(link), link).toBeNull();
    }
  });
});
