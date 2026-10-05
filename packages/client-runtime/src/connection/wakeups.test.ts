import { describe, expect, it } from "@effect/vitest";

import { isApplicationActiveWakeup, shouldResubscribeAfterWakeup } from "./wakeups.ts";

describe("connection wakeups", () => {
  it("treats Android foreground health checks as active without resubscribing streams", () => {
    expect(isApplicationActiveWakeup("application-active-health")).toBe(true);
    expect(shouldResubscribeAfterWakeup("application-active-health")).toBe(false);
  });

  it("preserves existing web and iOS resubscription semantics", () => {
    expect(shouldResubscribeAfterWakeup("application-active")).toBe(true);
    expect(shouldResubscribeAfterWakeup("application-active-probe")).toBe(true);
    expect(shouldResubscribeAfterWakeup("application-active-reconnect")).toBe(false);
  });
});
