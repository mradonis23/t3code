import type { ExternalFileOpenInput } from "./externalTools.shared";
export { ACODE_PACKAGE, SOLID_EXPLORER_PACKAGE } from "./externalTools.shared";
export { resolveExternalAppPackage } from "./externalTools.shared";
export type { ExternalAppKind, ExternalFileOpenInput } from "./externalTools.shared";

export function isExternalPackageInstalled(_packageName: string): boolean {
  return false;
}

export async function openExternalFile(_input: ExternalFileOpenInput): Promise<void> {
  throw new Error("External Android file tools are unavailable on this device.");
}
