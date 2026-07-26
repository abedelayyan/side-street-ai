import { describe, expect, it } from "vitest";
import { redactString } from "../src/redact.js";
import { placeholder } from "../src/patterns.js";

describe("known-literal redaction", () => {
  it("redacts an injected credential wherever it appears", () => {
    const secret = "sess-cred-abcdef123456";
    const out = redactString(`export TOKEN=${secret}; echo ${secret}`, [secret]);
    expect(out).not.toContain(secret);
    expect(out.match(/\[redacted:/g)).toHaveLength(2);
  });

  it("ignores literals below the minimum length (avoids over-redacting)", () => {
    expect(redactString("the value is ab", ["ab"])).toBe("the value is ab");
  });

  it("redacts the longest overlapping literal whole, not in pieces", () => {
    const out = redactString("cred abcdef-XYZ-secret end", ["abcdef", "abcdef-XYZ-secret"]);
    expect(out).toBe(`cred ${placeholder("secret")} end`);
  });
});

// Fixtures are assembled from parts so no complete provider-token literal
// appears in the source — otherwise secret-scanning push protection blocks
// the very tests that prove we redact these tokens.
const FIXTURES: Array<[string, string]> = [
  ["api-key", ["sk", "ant-api03", "A".repeat(24)].join("-")],
  ["aws-access-key", "AKIA" + "IOSFODNN7EXAMPLE"],
  ["github-token", "ghp" + "_" + "016C7f8A9b0C1d2E3f4G5h6I7j8K9l0M1n2O"],
  ["gcp-api-key", "AIza" + "SyD-1234567890abcdefghijklmnopqrstuv"],
  ["slack-token", ["xoxb", "1234567890", "abcdefghijklmno"].join("-")],
];

describe("built-in patterns", () => {
  it.each(FIXTURES)("redacts a %s", (label, secret) => {
    const out = redactString(`value: ${secret}`);
    expect(out).toBe(`value: ${placeholder(label)}`);
  });

  it("redacts a JWT", () => {
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dQw4w9WgXcQabcdef"].join(
      ".",
    );
    expect(redactString(jwt)).toBe(placeholder("jwt"));
  });

  it("redacts a PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123\n-----END RSA PRIVATE KEY-----";
    expect(redactString(`key:\n${pem}`)).toBe(`key:\n${placeholder("private-key")}`);
  });

  it("redacts a bearer token but keeps the scheme", () => {
    const out = redactString("Authorization: Bearer abcdefghijklmnop1234567890");
    expect(out).toBe(`Authorization: Bearer ${placeholder("bearer-token")}`);
  });
});

describe("env-style assignments", () => {
  it("keeps the key and separator, redacts only the value", () => {
    expect(redactString("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabc123")).toBe(
      `AWS_SECRET_ACCESS_KEY=${placeholder("env-secret")}`,
    );
  });

  it("handles quoted values and colon separators", () => {
    expect(redactString('DB_PASSWORD: "hunter2-very-secret"')).toBe(
      `DB_PASSWORD:${placeholder("env-secret")}`,
    );
  });

  it("does not fire on non-sensitive assignments", () => {
    expect(redactString("PORT=8787")).toBe("PORT=8787");
    expect(redactString("NODE_ENV=production")).toBe("NODE_ENV=production");
  });
});

describe("false-positive guard", () => {
  it("leaves ordinary prose and identifiers untouched", () => {
    const text = "Running node test.js in toolCall tc-42 for session bench-1; all tests pass.";
    expect(redactString(text)).toBe(text);
  });
});
