import type { Wakeups } from "@t3tools/client-runtime/connection";

export const MOBILE_BACKGROUND_RECONNECT_AFTER_MS = 10_000;

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active" | "application-active-probe" | "application-active-reconnect"
>;

export function mobileApplicationActiveWakeup(
  backgroundedAtMs: number | null,
  activeAtMs: number,
  platform: string,
): MobileApplicationActiveWakeup {
  // Android may retain a healthy socket through a long suspension. Give its
  // liveness probe the normal tolerance before replacing the session.
  if (platform === "android") return "application-active";
  return backgroundedAtMs !== null &&
    activeAtMs - backgroundedAtMs >= MOBILE_BACKGROUND_RECONNECT_AFTER_MS
    ? "application-active-reconnect"
    : "application-active-probe";
}
