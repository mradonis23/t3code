import type { ProviderInstanceId } from "@t3tools/contracts";

export interface CodexAccountPresentation {
  readonly label: string;
  readonly color: string;
}

const CODEX_ACCOUNT_PRESENTATIONS: Readonly<Record<string, CodexAccountPresentation>> = {
  codex: { label: "Dad's Codex", color: "#0A84FF" },
  codex_mom: { label: "Mom's Codex", color: "#FF9F0A" },
  codex_nena: { label: "Nena's Codex", color: "#30D158" },
};

export function codexAccountPresentation(
  instanceId: ProviderInstanceId | string,
): CodexAccountPresentation {
  return (
    CODEX_ACCOUNT_PRESENTATIONS[String(instanceId)] ?? {
      label: String(instanceId),
      color: "#0A84FF",
    }
  );
}
