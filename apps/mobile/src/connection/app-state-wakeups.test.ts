import { describe, expect, it } from "@effect/vitest";

import { mobileApplicationActiveWakeup } from "./app-state-wakeups";

describe("mobileApplicationActiveWakeup", () => {
  it("treats unknown or short background pauses as a quick foreground probe", () => {
    expect(mobileApplicationActiveWakeup(null, 5_000)).toBe("application-active-probe");
    expect(mobileApplicationActiveWakeup(1_000, 3_999)).toBe("application-active-probe");
  });

  it("escalates to application-active-long once backgrounded for at least 3 seconds", () => {
    expect(mobileApplicationActiveWakeup(1_000, 4_000)).toBe("application-active-long");
    expect(mobileApplicationActiveWakeup(1_000, 12_000)).toBe("application-active-long");
  });
});
