import { describe, expect, it } from "vite-plus/test";

import {
  onshapeHostsDiffer,
  resolveOnshapeEnvironmentSelection,
  safeOnshapeConnectionErrorMessage,
  validateOnshapeConnectionDraft,
  validateOnshapeCredentialDraft,
} from "./OnshapeConnectionsSettings.logic";

describe("Onshape connection form logic", () => {
  it("trims a complete connection draft before it crosses the wire", () => {
    expect(
      validateOnshapeConnectionDraft({
        name: "  Team Onshape  ",
        host: " cad.onshape.com ",
        accessKeyId: "  access-id  ",
        secretKey: "  secret  ",
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "Team Onshape",
        host: "cad.onshape.com",
        accessKeyId: "access-id",
        secretKey: "secret",
      },
    });
  });

  it("rejects every missing credential field before spending an Onshape request", () => {
    expect(validateOnshapeCredentialDraft({ host: " ", accessKeyId: "", secretKey: "\t" })).toEqual(
      {
        ok: false,
        errors: {
          host: "Stack host is required.",
          accessKeyId: "Access key ID is required.",
          secretKey: "Secret key is required.",
        },
      },
    );
  });

  it("rejects overlong connection data before it reaches contract decoding", () => {
    const validation = validateOnshapeConnectionDraft({
      name: "n".repeat(121),
      host: "h".repeat(254),
      accessKeyId: "a".repeat(257),
      secretKey: "s".repeat(513),
    });

    expect(validation).toEqual({
      ok: false,
      errors: {
        name: "Name must be 120 characters or fewer.",
        host: "Stack host must be 253 characters or fewer.",
        accessKeyId: "Access key ID must be 256 characters or fewer.",
        secretKey: "Secret key must be 512 characters or fewer.",
      },
    });
  });

  it("shows quota and retry guidance without reflecting unknown error content", () => {
    expect(
      safeOnshapeConnectionErrorMessage({ _tag: "OnshapeAnnualQuotaExceededError" }),
    ).toContain("annual API quota");
    expect(
      safeOnshapeConnectionErrorMessage({
        _tag: "OnshapeRateLimitError",
        retryAfterSeconds: 61,
      }),
    ).toBe("Onshape is rate limiting requests. Try again in 2 minutes.");
    expect(safeOnshapeConnectionErrorMessage(new Error("secret=do-not-render"))).not.toContain(
      "do-not-render",
    );
  });

  it("gives permission, redirect, and verification throttle failures distinct safe guidance", () => {
    expect(
      safeOnshapeConnectionErrorMessage({ _tag: "OnshapeInsufficientPermissionsError" }),
    ).toContain("document read access");
    expect(safeOnshapeConnectionErrorMessage({ _tag: "OnshapeRedirectError" })).toBe(
      "Onshape redirected the verification request. Confirm the exact stack host where this key was created before saving again.",
    );
    expect(
      safeOnshapeConnectionErrorMessage({
        _tag: "OnshapeVerificationThrottledError",
        retryAfterSeconds: 1,
      }),
    ).toBe("Too many connection verification attempts. Try again in 1 second.");
    expect(safeOnshapeConnectionErrorMessage({ _tag: "OnshapeVerificationThrottledError" })).toBe(
      "Too many connection verification attempts. Try again later.",
    );
  });

  it("keeps the active device selected until its editor or mutation releases the lock", () => {
    expect(resolveOnshapeEnvironmentSelection("primary", "workstation", true)).toBe("primary");
    expect(resolveOnshapeEnvironmentSelection("primary", "workstation", false)).toBe("workstation");
  });

  it("distinguishes a stack change from equivalent host formatting", () => {
    expect(onshapeHostsDiffer("https://cad.onshape.com", "cad.onshape.com/")).toBe(false);
    expect(onshapeHostsDiffer("https://cad.onshape.com", "team.onshape.com")).toBe(true);
  });
});
