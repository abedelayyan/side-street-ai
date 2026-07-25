import { describe, expect, it } from "vitest";
import { ROLES, canApproveTools, canSteer, canSuggest, roleSchema } from "../src/roles.js";

describe("roles", () => {
  it("defines exactly driver, navigator, observer", () => {
    expect(ROLES).toEqual(["driver", "navigator", "observer"]);
    expect(roleSchema.safeParse("driver").success).toBe(true);
    expect(roleSchema.safeParse("admin").success).toBe(false);
  });

  it("grants steering and tool approval to the driver only", () => {
    expect(canSteer("driver")).toBe(true);
    expect(canSteer("navigator")).toBe(false);
    expect(canSteer("observer")).toBe(false);
    expect(canApproveTools("driver")).toBe(true);
    expect(canApproveTools("navigator")).toBe(false);
    expect(canApproveTools("observer")).toBe(false);
  });

  it("lets navigators suggest but keeps observers read-only", () => {
    expect(canSuggest("driver")).toBe(true);
    expect(canSuggest("navigator")).toBe(true);
    expect(canSuggest("observer")).toBe(false);
  });
});
