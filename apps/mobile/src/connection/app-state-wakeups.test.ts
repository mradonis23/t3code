import { describe, expect, it } from "@effect/vitest";

import {
  MOBILE_BACKGROUND_RECONNECT_AFTER_MS,
  mobileApplicationActiveWakeup,
} from "./app-state-wakeups";

describe("mobileApplicationActiveWakeup", () => {
  it("uses a fast probe after a short interruption", () => {
    expect(mobileApplicationActiveWakeup(null, 20_000, "ios")).toBe("application-active-probe");
    expect(
      mobileApplicationActiveWakeup(
        20_000,
        20_000 + MOBILE_BACKGROUND_RECONNECT_AFTER_MS - 1,
        "ios",
      ),
    ).toBe("application-active-probe");
  });

  it("replaces the session after a meaningful background suspension", () => {
    expect(
      mobileApplicationActiveWakeup(20_000, 20_000 + MOBILE_BACKGROUND_RECONNECT_AFTER_MS, "ios"),
    ).toBe("application-active-reconnect");
  });

  it.each([0, 9_999, 10_000, 60_000, 3_600_000])(
    "uses the tolerant liveness probe on Android after %i ms in the background",
    (elapsed) => {
      expect(mobileApplicationActiveWakeup(20_000, 20_000 + elapsed, "android")).toBe(
        "application-active",
      );
    },
  );

  it("probes Android on activation without a recorded background event", () => {
    expect(mobileApplicationActiveWakeup(null, 20_000, "android")).toBe("application-active");
  });
});
