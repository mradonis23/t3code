const SHELL_LANGUAGES = new Set([
  "bash",
  "batch",
  "cmd",
  "powershell",
  "ps1",
  "pwsh",
  "sh",
  "shell",
  "zsh",
]);

export function isRunnableShellBlock(
  language: string | null | undefined,
  command: string,
): boolean {
  return command.trim().length > 0 && SHELL_LANGUAGES.has(language?.trim().toLowerCase() ?? "");
}
