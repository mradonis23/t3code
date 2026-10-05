export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  if (platform === "ios" || platform === "android") {
    return { supported: true, subtitle: undefined };
  }
  return { supported: false, subtitle: "Unavailable on this platform" };
}
