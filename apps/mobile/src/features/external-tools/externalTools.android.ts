import { requireOptionalNativeModule } from "expo";

import type { ExternalFileOpenInput } from "./externalTools.shared";
export { ACODE_PACKAGE, SOLID_EXPLORER_PACKAGE } from "./externalTools.shared";
export { resolveExternalAppPackage } from "./externalTools.shared";
export type { ExternalAppKind, ExternalFileOpenInput } from "./externalTools.shared";

interface NativeExternalTools {
  readonly isPackageInstalled: (packageName: string) => boolean;
  readonly openExternalFile: (
    contentUri: string,
    mimeType: string,
    packageName: string | null,
    editable: boolean,
    forceChooser: boolean,
    chooserTitle: string,
  ) => Promise<void>;
}

function nativeModule(): NativeExternalTools | null {
  return requireOptionalNativeModule<NativeExternalTools>("T3NativeControls");
}

export function isExternalPackageInstalled(packageName: string): boolean {
  try {
    return nativeModule()?.isPackageInstalled(packageName) === true;
  } catch {
    return false;
  }
}

export async function openExternalFile(input: ExternalFileOpenInput): Promise<void> {
  const module = nativeModule();
  if (module === null) {
    throw new Error("External Android file tools are unavailable in this build.");
  }
  const { File } = await import("expo-file-system");
  const file = new File(input.uri);
  await module.openExternalFile(
    file.contentUri,
    input.mimeType,
    input.packageName ?? null,
    input.editable,
    input.forceChooser,
    input.chooserTitle,
  );
}
