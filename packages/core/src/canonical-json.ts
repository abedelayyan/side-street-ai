/**
 * Deterministic JSON serialization for hashing.
 *
 * Two structurally equal values must always serialize to the same string,
 * regardless of object key insertion order, or the hash chain breaks across
 * runtimes and refactors. Values that JSON cannot represent faithfully are
 * rejected rather than silently coerced, because a silent `undefined → drop`
 * or `NaN → null` would let two different events share one hash.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function canonicalStringify(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot canonicalize non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) {
        const items = value.map((item, i) => serialize(item, `${path}[${i}]`));
        return `[${items.join(",")}]`;
      }
      return serializeObject(value as Record<string, unknown>, path);
    default:
      throw new TypeError(`Cannot canonicalize value of type ${typeof value} at ${path}`);
  }
}

function serializeObject(obj: Record<string, unknown>, path: string): string {
  if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) {
    throw new TypeError(`Cannot canonicalize non-plain object at ${path}`);
  }
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const key of keys) {
    const entryValue = obj[key];
    if (entryValue === undefined) {
      throw new TypeError(`Cannot canonicalize undefined at ${path}.${key}`);
    }
    entries.push(`${JSON.stringify(key)}:${serialize(entryValue, `${path}.${key}`)}`);
  }
  return `{${entries.join(",")}}`;
}
