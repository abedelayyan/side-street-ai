import { describe, expect, it } from "vitest";
import { canonicalStringify } from "../src/canonical-json.js";

describe("canonicalStringify", () => {
  it("serializes primitives like JSON", () => {
    expect(canonicalStringify("a")).toBe('"a"');
    expect(canonicalStringify(42)).toBe("42");
    expect(canonicalStringify(true)).toBe("true");
    expect(canonicalStringify(null)).toBe("null");
  });

  it("is independent of object key insertion order", () => {
    const a = { x: 1, y: { b: 2, a: 3 } };
    const b = { y: { a: 3, b: 2 }, x: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("preserves array order", () => {
    expect(canonicalStringify([2, 1])).toBe("[2,1]");
    expect(canonicalStringify([2, 1])).not.toBe(canonicalStringify([1, 2]));
  });

  it("round-trips through JSON.parse to a structurally equal value", () => {
    const value = { s: "hi", n: 1.5, arr: [true, null, { k: "v" }] };
    expect(JSON.parse(canonicalStringify(value))).toEqual(value);
  });

  it("rejects undefined values instead of silently dropping them", () => {
    expect(() => canonicalStringify({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalStringify(undefined)).toThrow(TypeError);
  });

  it("rejects non-finite numbers instead of coercing to null", () => {
    expect(() => canonicalStringify(NaN)).toThrow(TypeError);
    expect(() => canonicalStringify({ a: Infinity })).toThrow(TypeError);
  });

  it("rejects functions, symbols, bigints, and class instances", () => {
    expect(() => canonicalStringify(() => 1)).toThrow(TypeError);
    expect(() => canonicalStringify(Symbol("s"))).toThrow(TypeError);
    expect(() => canonicalStringify(1n)).toThrow(TypeError);
    expect(() => canonicalStringify(new Date())).toThrow(TypeError);
  });

  it("escapes strings safely", () => {
    expect(canonicalStringify('a"b\n')).toBe(JSON.stringify('a"b\n'));
  });
});
