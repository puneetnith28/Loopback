import { describe, expect, it } from "vitest";
import { checkReleaseReadiness } from "../../scripts/release-check.mjs";

describe("release-check", () => {
  it("confirms all workspace manifests match the current version", () => {
    const res = checkReleaseReadiness();
    expect(res.version).toBe("0.1.0");
    expect(res.tag).toBe("v0.1.0");
    expect(res.checkedFiles.length).toBe(6);
  });

  it("succeeds when expected version matches tag", () => {
    expect(() => checkReleaseReadiness("v0.1.0")).not.toThrow();
    expect(() => checkReleaseReadiness("0.1.0")).not.toThrow();
  });

  it("throws when expected version mismatches", () => {
    expect(() => checkReleaseReadiness("v1.0.0")).toThrow(/does not match expected release version/);
  });
});
