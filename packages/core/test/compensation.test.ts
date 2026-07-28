import { describe, expect, it } from "vitest";
import { stepIdFor } from "../src/compensation.js";

describe("stepIdFor", () => {
  it("is stable for the same approval prompt and differs for another", async () => {
    const title = "Run `curl -X POST https://api.example.com/deploy`";
    expect(await stepIdFor(title)).toBe(await stepIdFor(title));
    expect(await stepIdFor(title)).not.toBe(await stepIdFor(`${title} `));
    expect(await stepIdFor(title)).toMatch(/^[0-9a-f]{16}$/);
  });
});
