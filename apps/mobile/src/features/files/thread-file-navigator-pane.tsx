import type {
  EnvironmentId,
  ProjectListEntriesResult,
  ProjectSearchContentsResult,
} from "@t3tools/contracts";
import { SymbolView } from "../../components/AppSymbol";
import { useCallback, useMemo, useState, type ComponentProps } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  View,
  type NativeSyntheticEvent,
} from "react-native";
import {
  Screen,
  ScreenStack,
  ScreenStackHeaderConfig,
  ScreenStackHeaderSearchBarView,
  SearchBar,
} from "react-native-screens";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { EmptyState } from "../../components/EmptyState";
import { FileTreeBrowser } from "./FileTreeBrowser";
import { preloadWorkspaceFileContents } from "./preload-workspace-file";

export function ThreadFileNavigatorPane(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly headerInset: number;
  readonly projectName: string;
  readonly selectedPath: string | null;
  readonly onSelectFile: (path: string, line?: number) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"files" | "contents">("files");
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 250);
  const { themeAppearance: highlightTheme } = useAppearancePreferences();
  const theme = useUniwindTheme();
  const foregroundColor = theme["--color-foreground"];
  const sheetColor = theme["--color-sheet"];
  const headerScrollEdgeEffects = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
  const entriesQuery = useEnvironmentQuery(
    projectEnvironment.listEntries({
      environmentId: props.environmentId,
      input: { cwd: props.cwd },
    }),
  );
  const entriesData = entriesQuery.data as ProjectListEntriesResult | null;
  const contentSearchQuery = useEnvironmentQuery(
    searchMode === "contents" && debouncedSearchQuery.length > 0
      ? projectEnvironment.searchContents({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            query: debouncedSearchQuery,
            limit: 100,
            caseSensitive: false,
            wholeWord: false,
            useRegex: false,
          },
        })
      : null,
  );
  const contentSearchData = contentSearchQuery.data as ProjectSearchContentsResult | null;
  const handlePreviewFile = useCallback(
    (relativePath: string) => {
      preloadWorkspaceFileContents({
        cwd: props.cwd,
        environmentId: props.environmentId,
        relativePath,
        theme: highlightTheme,
      });
    },
    [highlightTheme, props.cwd, props.environmentId],
  );
  const nativeHeaderRightBarButtonItems = useMemo(
    () =>
      [
        {
          accessibilityLabel: "Refresh files",
          icon: { name: "arrow.clockwise", type: "sfSymbol" as const },
          identifier: "thread-file-navigator-refresh",
          onPress: entriesQuery.refresh,
          sharesBackground: false,
          tintColor: foregroundColor,
          type: "button" as const,
          width: 44,
        },
      ] as ComponentProps<typeof ScreenStackHeaderConfig>["headerRightBarButtonItems"],
    [entriesQuery.refresh, foregroundColor],
  );

  const modeSwitch = (
    <View className="flex-row gap-2 border-b border-border px-3 py-2">
      {(["files", "contents"] as const).map((mode) => (
        <Pressable
          key={mode}
          accessibilityLabel={`Search ${mode}`}
          accessibilityRole="button"
          className={
            searchMode === mode
              ? "min-h-10 justify-center rounded-xl bg-accent px-4"
              : "min-h-10 justify-center rounded-xl bg-subtle px-4"
          }
          onPress={() => setSearchMode(mode)}
        >
          <Text
            className={
              searchMode === mode
                ? "text-xs font-t3-bold text-accent-foreground"
                : "text-xs font-t3-bold text-foreground-secondary"
            }
          >
            {mode === "files" ? "Files" : "Contents"}
          </Text>
        </Pressable>
      ))}
    </View>
  );
  const fileTree = (
    <>
      {modeSwitch}
      {searchMode === "files" ? (
        <FileTreeBrowser
          entries={entriesData?.entries ?? []}
          error={entriesQuery.error}
          isPending={entriesQuery.isPending}
          searchQuery={searchQuery}
          selectedPath={props.selectedPath}
          onPreviewFile={handlePreviewFile}
          onRefresh={entriesQuery.refresh}
          onSelectFile={props.onSelectFile}
        />
      ) : (
        <ScrollView className="flex-1" contentContainerClassName="gap-1 p-2">
          {debouncedSearchQuery.length === 0 ? (
            <EmptyState
              title="Search file contents"
              detail="Enter text to search this workspace."
            />
          ) : contentSearchQuery.isPending ? (
            <ActivityIndicator className="my-8" />
          ) : contentSearchQuery.error ? (
            <EmptyState title="Search unavailable" detail={contentSearchQuery.error} />
          ) : contentSearchData?.matches.length ? (
            contentSearchData.matches.map((match) => (
              <Pressable
                key={`${match.path}:${match.lineNumber}:${match.lineContent}`}
                accessibilityLabel={`Open ${match.path} at line ${match.lineNumber}`}
                accessibilityRole="button"
                className="min-h-12 rounded-xl px-2 py-2 active:bg-subtle"
                onPress={() => props.onSelectFile(match.path, match.lineNumber)}
              >
                <Text className="text-xs font-t3-bold text-foreground" numberOfLines={1}>
                  {match.path}:{match.lineNumber}
                </Text>
                <Text className="font-mono text-xs text-foreground-muted" numberOfLines={2}>
                  {match.lineContent}
                </Text>
              </Pressable>
            ))
          ) : (
            <EmptyState title="No matches" detail="No workspace text matched this search." />
          )}
        </ScrollView>
      )}
    </>
  );

  if (Platform.OS === "ios") {
    return (
      <View className="flex-1 border-l border-border bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-file-navigator-native"
            scrollEdgeEffects={headerScrollEdgeEffects}
            style={{ backgroundColor: sheetColor, flex: 1 }}
          >
            {fileTree}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={foregroundColor}
              headerRightBarButtonItems={nativeHeaderRightBarButtonItems}
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              subtitle={props.projectName}
              title="Files"
              titleColor={foregroundColor}
              titleFontSize={17}
              titleFontWeight="700"
              translucent
            >
              <ScreenStackHeaderSearchBarView>
                <SearchBar
                  allowToolbarIntegration
                  autoCapitalize="none"
                  barTintColor={sheetColor}
                  hideNavigationBar={false}
                  hideWhenScrolling={false}
                  obscureBackground={false}
                  onCancelButtonPress={() => {
                    setSearchQuery("");
                  }}
                  onChangeText={(event: NativeSyntheticEvent<{ readonly text?: string }>) => {
                    setSearchQuery(event.nativeEvent.text ?? "");
                  }}
                  placement="integratedButton"
                  placeholder={searchMode === "contents" ? "Search contents" : "Search files"}
                  textColor={foregroundColor}
                  tintColor={foregroundColor}
                />
              </ScreenStackHeaderSearchBarView>
            </ScreenStackHeaderConfig>
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View className="flex-1 border-l border-border bg-sheet">
      <View className="border-b border-border" style={{ paddingTop: props.headerInset }}>
        <View className="h-12 flex-row items-center gap-2 px-3">
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-t3-bold text-foreground">Files</Text>
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {props.projectName}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh files"
            hitSlop={8}
            className="h-8 w-8 items-center justify-center rounded-full active:bg-subtle"
            onPress={entriesQuery.refresh}
          >
            <SymbolView
              name="arrow.clockwise"
              size={14}
              tintColorClassName={"accent-icon-muted"}
              type="monochrome"
            />
          </Pressable>
        </View>
        <View className="flex-row items-center gap-2 border-t border-border px-3 py-2">
          <SymbolView
            name="magnifyingglass"
            size={15}
            tintColorClassName={"accent-icon-muted"}
            type="monochrome"
          />
          <TextInput
            accessibilityLabel={searchMode === "contents" ? "Search file contents" : "Search files"}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            className="min-h-10 flex-1 rounded-xl py-2 text-sm"
            placeholder={searchMode === "contents" ? "Search contents" : "Search files"}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
      </View>
      {fileTree}
    </View>
  );
}
