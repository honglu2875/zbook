import { describe, expect, it } from "vitest";
import { contentRevision, sameContentRevision } from "./contentRevision";

describe("content revisions", () => {
  it("prefers matching server hashes over timestamps", () => {
    const first = { lastModified: "later", hash: "abc", hashAlgorithm: "sha256" };
    const sameContent = { lastModified: "earlier", hash: "abc", hashAlgorithm: "sha256" };
    const changedContent = { lastModified: "later", hash: "def", hashAlgorithm: "sha256" };

    expect(sameContentRevision(first, sameContent)).toBe(true);
    expect(sameContentRevision(first, changedContent)).toBe(false);
  });

  it("falls back to last-modified when compatible hashes are unavailable", () => {
    const first = { lastModified: "same", hash: null, hashAlgorithm: null };
    const same = { lastModified: "same", hash: "abc", hashAlgorithm: "sha256" };
    const changed = { lastModified: "changed", hash: null, hashAlgorithm: null };

    expect(sameContentRevision(first, same)).toBe(true);
    expect(sameContentRevision(first, changed)).toBe(false);
  });

  it("normalizes a Jupyter content model", () => {
    expect(contentRevision({
      last_modified: "2026-08-23T00:00:00Z",
      hash: "abc",
      hash_algorithm: "sha256",
    })).toEqual({
      lastModified: "2026-08-23T00:00:00Z",
      hash: "abc",
      hashAlgorithm: "sha256",
    });
  });
});
