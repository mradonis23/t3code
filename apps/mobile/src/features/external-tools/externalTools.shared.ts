export const ACODE_PACKAGE = "com.foxdebug.acodefree";
export const SOLID_EXPLORER_PACKAGE = "pl.solidexplorer2";

export interface ExternalFileOpenInput {
  readonly uri: string;
  readonly mimeType: string;
  readonly packageName?: string | null;
  readonly editable: boolean;
  readonly forceChooser: boolean;
  readonly chooserTitle: string;
}

export type ExternalAppKind = "acode" | "system" | "solid-explorer";

export function resolveExternalAppPackage(
  kind: ExternalAppKind,
  isInstalled: (packageName: string) => boolean,
):
  | { readonly status: "available"; readonly packageName: string | null }
  | {
      readonly status: "unavailable";
      readonly packageName: string;
    } {
  const packageName =
    kind === "acode" ? ACODE_PACKAGE : kind === "solid-explorer" ? SOLID_EXPLORER_PACKAGE : null;
  if (packageName === null || isInstalled(packageName)) {
    return { status: "available", packageName };
  }
  return { status: "unavailable", packageName };
}
