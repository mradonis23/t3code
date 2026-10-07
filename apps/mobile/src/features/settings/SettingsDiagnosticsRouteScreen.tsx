import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  diagnosticsProviderLabel,
  diagnosticsTextSummary,
  operationalReportCards,
  summarizeWork,
  WORK_CATEGORIES,
  workCount,
} from "@t3tools/client-runtime/diagnostics";
import * as Option from "effect/Option";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { threadOutboxManager } from "../../state/thread-outbox";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsDiagnosticsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    environments.find((entry) => entry.environmentId === selectedId) ??
    environments.find((entry) => entry.connection.phase === "connected") ??
    environments[0];
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="T3 Status" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {environments.length > 1 ? (
          <SettingsSection title="Environment">
            {environments.map((entry) => (
              <Pressable
                key={entry.environmentId}
                accessibilityRole="button"
                accessibilityState={{ selected: entry === selected }}
                onPress={() => setSelectedId(entry.environmentId)}
                className="p-4"
              >
                <Text className="text-foreground">
                  {entry.label}
                  {entry === selected ? " ✓" : ""}
                </Text>
              </Pressable>
            ))}
          </SettingsSection>
        ) : null}
        {selected ? (
          <EnvironmentDiagnostics key={selected.environmentId} environment={selected} />
        ) : (
          <Text className="text-foreground-muted">Connect an environment to run diagnostics.</Text>
        )}
      </ScrollView>
    </View>
  );
}

function EnvironmentDiagnostics({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const { environmentId } = environment;
  const navigation = useNavigation();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const snapshot = Option.getOrNull(shell.snapshot);
  const queues = useAtomValue(threadOutboxManager.queuedMessagesByThreadKeyAtom);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const report = useEnvironmentQuery(
    serverEnvironment.operationalDiagnostics({ environmentId, input: {} }),
  );
  const traces = useEnvironmentQuery(
    serverEnvironment.traceDiagnostics({ environmentId, input: {} }),
  );
  const work = useMemo(
    () =>
      summarizeWork({
        environmentId,
        threads: snapshot?.threads ?? [],
        queue: Object.values(queues).flat(),
        // Hermes does not ship Array.prototype.toSorted(); sort a fresh literal instead.
        now: [report.data?.readAt ?? "", snapshot?.updatedAt ?? ""].sort().at(-1) ?? "",
      }),
    [environmentId, snapshot, queues, report.data?.readAt],
  );
  const cards = operationalReportCards({
    data: report.data,
    config,
    connection: environment.connection.phase,
    sync: shell.status,
    syncSequence: snapshot?.snapshotSequence ?? null,
    error: report.error,
    work,
  });
  const recentErrors = traces.data?.latestFailures
    .slice(0, 5)
    .map((failure) => `${failure.name}: ${failure.cause.slice(0, 500)}`) ?? [
    traces.error ?? "Trace diagnostics unavailable",
  ];
  const summary = diagnosticsTextSummary({ cards, config, data: report.data, work, recentErrors });
  const toggle = (key: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const openThread = (threadId: string) =>
    navigation.navigate("Thread", { environmentId: String(environmentId), threadId });

  return (
    <>
      <SettingsSection title="T3 Status">
        <Pressable
          accessibilityRole="button"
          disabled={report.isPending}
          onPress={() => {
            report.refresh();
            traces.refresh();
          }}
          className="p-4"
        >
          <Text className="text-primary">
            {report.isPending ? "Checking…" : "Run T3 diagnostics"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void Share.share({ message: summary });
          }}
          className="p-4"
        >
          <Text className="text-primary">Share diagnostics summary</Text>
        </Pressable>
        {report.error ? (
          <Text className="p-4 text-foreground-muted">
            Latest check failed: {report.error}
            {report.data ? ` · Showing last successful report from ${report.data.readAt}` : ""}
          </Text>
        ) : null}
        {cards.map((card) => (
          <View key={card.label} className="gap-1 p-4">
            <Text className="text-sm text-foreground-muted">{card.label}</Text>
            <Text selectable className="text-foreground">
              {card.value}
            </Text>
            <Text selectable className="text-sm text-foreground-muted">
              {card.detail}
            </Text>
          </View>
        ))}
      </SettingsSection>
      <SettingsSection title="Providers / accounts · last known checks">
        {config?.providers.map((provider) => (
          <View key={provider.instanceId} className="gap-1 p-4">
            <Text className="text-foreground">
              {diagnosticsProviderLabel(provider)} · {provider.status} · {provider.auth.status}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {provider.driver} · version {provider.version ?? "unavailable"} · checked{" "}
              {provider.checkedAt}
            </Text>
          </View>
        )) ?? <Text className="p-4 text-foreground-muted">Unavailable</Text>}
      </SettingsSection>
      <SettingsSection title="Work Queue">
        <Text className="p-4 text-sm text-foreground-muted">
          All threads in this environment; queued/paused messages on this device; completed within
          24 hours as of the latest state or check. Shell: {shell.status}.
        </Text>
        {WORK_CATEGORIES.map((category) => (
          <View key={category} className="p-4">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: expanded.has(category) }}
              onPress={() => toggle(category)}
            >
              <Text className="text-foreground">
                {category}: {workCount(work[category])} {expanded.has(category) ? "−" : "+"}
              </Text>
            </Pressable>
            {expanded.has(category) ? (
              work[category].length === 0 ? (
                <Text className="pt-2 text-sm text-foreground-muted">
                  None in the available state.
                </Text>
              ) : (
                work[category].map((entry) => (
                  <Pressable
                    key={entry.threadId}
                    accessibilityRole="button"
                    disabled={!entry.navigable}
                    onPress={() => openThread(entry.threadId)}
                    className="pt-3"
                  >
                    <Text className="text-primary">
                      {entry.title}
                      {entry.count > 1 ? ` (${entry.count} messages)` : ""}
                      {!entry.navigable ? " · thread creation pending" : ""}
                    </Text>
                  </Pressable>
                ))
              )
            ) : null}
          </View>
        ))}
      </SettingsSection>
      <SettingsSection title="Native Sessions">
        <Text className="p-4 text-sm text-foreground-muted">
          Last known bindings. A resumable stopped cursor still requires provider availability and
          authentication.
        </Text>
        {!report.data?.nativeSessionsAvailable ? (
          <Text className="p-4 text-foreground-muted">Native session state unavailable.</Text>
        ) : report.data.nativeSessions.length === 0 ? (
          <Text className="p-4 text-foreground-muted">No bindings recorded.</Text>
        ) : (
          report.data.nativeSessions.map((session) => {
            const provider = config?.providers.find(
              (entry) => entry.instanceId === session.providerInstanceId,
            );
            const thread = snapshot?.threads.find((entry) => entry.id === session.threadId);
            const key = `native:${session.threadId}`;
            return (
              <View key={key} className="gap-2 p-4">
                {thread ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => openThread(session.threadId)}
                  >
                    <Text className="text-primary">{thread.title}</Text>
                  </Pressable>
                ) : null}
                <Text className="text-foreground">
                  {provider
                    ? diagnosticsProviderLabel(provider)
                    : (session.providerInstanceId ?? session.provider)}{" "}
                  · {session.status ?? "unknown"} · resumable: {session.resumable ? "yes" : "no"}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  Last seen {session.lastSeenAt} · synchronized{" "}
                  {session.lastSynchronizedAt ?? "time unavailable"}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: expanded.has(key) }}
                  onPress={() => toggle(key)}
                >
                  <Text className="text-primary">Details / Advanced</Text>
                </Pressable>
                {expanded.has(key) ? (
                  <Text selectable className="text-sm text-foreground-muted">
                    Native session ID: {session.nativeSessionId ?? "unavailable"}
                  </Text>
                ) : null}
              </View>
            );
          })
        )}
      </SettingsSection>
      <SettingsSection title="Recent trace errors">
        <Text selectable className="p-4 text-sm text-foreground-muted">
          {recentErrors.join("\n") || "No failures in available traces."}
        </Text>
      </SettingsSection>
    </>
  );
}
