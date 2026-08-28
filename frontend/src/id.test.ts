import { afterEach, describe, expect, it, vi } from "vitest";
import { createUuid } from "./id";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createUuid", () => {
  it("uses the browser UUID implementation when available", () => {
    const expected = "11111111-2222-4333-8444-555555555555";
    vi.stubGlobal("crypto", {
      randomUUID: () => expected,
    });

    expect(createUuid()).toBe(expected);
  });

  it("creates a valid UUID when randomUUID is unavailable on plain HTTP", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.forEach((_value, index) => { bytes[index] = index; });
        return bytes;
      },
    });

    expect(createUuid()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });
});
