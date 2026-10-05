import type { MobileRecentWorkspaceFile } from "../../persistence/mobile-preferences";

export const MAX_MOBILE_EDIT_BYTES = 256 * 1024;
export const MAX_MOBILE_EDIT_LINES = 20_000;

export function hostWorkspaceFilePath(cwd: string, relativePath: string): string {
  const separator = cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[\\/]$/, "")}${separator}${relativePath.replaceAll("/", separator)}`;
}

export function workspaceFileMimeType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "css":
      return "text/css";
    case "csv":
      return "text/csv";
    case "html":
    case "htm":
      return "text/html";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "text/javascript";
    case "json":
      return "application/json";
    case "md":
    case "mdx":
      return "text/markdown";
    case "ts":
    case "tsx":
      return "text/typescript";
    case "xml":
      return "application/xml";
    case "yaml":
    case "yml":
      return "application/yaml";
    default:
      return "text/plain";
  }
}

export function recordRecentWorkspaceFile(
  current: ReadonlyArray<MobileRecentWorkspaceFile>,
  opened: MobileRecentWorkspaceFile,
): ReadonlyArray<MobileRecentWorkspaceFile> {
  return [
    opened,
    ...current.filter(
      (entry) =>
        entry.environmentId !== opened.environmentId ||
        entry.cwd !== opened.cwd ||
        entry.path !== opened.path,
    ),
  ].slice(0, 20);
}

export async function cacheWorkspaceTextFile(input: {
  readonly path: string;
  readonly contents: string;
}): Promise<string> {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.cache, "workspace-file-handoffs");
  directory.create({ idempotent: true, intermediates: true });
  const safeName =
    input.path
      .split(/[\\/]/)
      .pop()
      ?.replace(/[^a-zA-Z0-9._-]/g, "_") || "file.txt";
  const file = new File(directory, `${Date.now()}-${safeName}`);
  file.write(input.contents);
  return file.uri;
}
