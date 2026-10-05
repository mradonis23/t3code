import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import {
  StackActions,
  useFocusEffect,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import type { MenuAction } from "@react-native-menu/menu";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AsyncResult } from "effect/unstable/reactivity";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import {
  EnvironmentId,
  type ProjectListEntriesResult,
  type ProjectReadFileResult,
  type ProjectSearchContentsResult,
  ThreadId,
} from "@t3tools/contracts";
import { videoMimeType } from "@t3tools/shared/video";
import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  mediaMimeTypeFromExtension,
} from "@t3tools/shared/filePreview";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { LoadingScreen } from "../../components/LoadingScreen";
import { resolveFileSelectionNavigationAction } from "../../lib/adaptive-navigation";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { isPdfFile } from "../../lib/filePreview";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { shareLocalAttachment } from "../../lib/attachmentDownload";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type { MediaVideoPreviewSource } from "../../lib/videoPreviewSource";
import { useMediaActions, type MediaActionsSource } from "../../lib/mediaActions";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";
import { projectEnvironment } from "../../state/projects";
import type { AssetUrlFailureReason } from "../../state/asset-url-state";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import type { MobileExternalEditSession } from "../../persistence/mobile-preferences";
import { uuidv4 } from "../../lib/uuid";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { ThreadRouteScreen } from "../threads/ThreadRouteScreen";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { FileTreeBrowser } from "./FileTreeBrowser";
import { AcodeEditReviewSheet } from "./AcodeEditReviewSheet";
import {
  buildExternalEditDiff,
  buildExternalEditWriteInput,
  compareExternalEditSnapshot,
  createExternalEditSession,
  findExternalEditSession,
  markExternalEditOpened,
  MAX_EXTERNAL_EDIT_SESSIONS,
  prunePreparingExternalEditSessions,
  removeExternalEditSession,
} from "./acode-edit-session";
import {
  cleanupExternalEditSnapshots,
  createExternalEditSnapshot,
  readExternalEditSnapshot,
  removeExternalEditSnapshot,
} from "./acode-edit-storage";
import { preloadWorkspaceFileContents } from "./preload-workspace-file";
import { SourceFileSurface } from "./SourceFileSurface";
import { ThreadFileNavigatorPane } from "./thread-file-navigator-pane";
import { WorkspaceFileImagePreview } from "./WorkspaceFileImagePreview";
import { WorkspaceFilePreviewError } from "./WorkspaceFilePreviewError";
import { WorkspaceFileVideoPreview } from "./WorkspaceFileVideoPreview";
import { WorkspaceFileWebPreview } from "./WorkspaceFileWebPreview";
import { WorkspaceTextEditor, type WorkspaceEditorSaveResult } from "./WorkspaceTextEditor";
import {
  cacheWorkspaceTextFile,
  hostWorkspaceFilePath,
  MAX_MOBILE_EDIT_BYTES,
  MAX_MOBILE_EDIT_LINES,
  recordRecentWorkspaceFile,
  workspaceFileMimeType,
} from "./workspace-file-tools";
import {
  isExternalPackageInstalled,
  openExternalFile,
  resolveExternalAppPackage,
} from "../external-tools/externalTools";
import {
  basename,
  isAbsolutePath,
  isMarkdownPreviewFile,
  isSvgImagePreviewFile,
  isVideoPreviewFile,
} from "./filePath";
import { useWorkspaceFileAssetUrlState } from "./workspaceFileAssetUrl";

type FileViewMode = "preview" | "source" | "edit";

type PendingExternalEdit = {
  readonly session: MobileExternalEditSession;
  readonly originalContents: string;
  readonly snapshotContents: string;
};

function AcodeEditBanner(props: {
  readonly session: MobileExternalEditSession;
  readonly workspaceIdentity: string;
  readonly additions: number;
  readonly deletions: number;
  readonly onViewDiff: () => void;
  readonly onApply: () => void;
  readonly onDiscard: () => void;
  readonly onCheck: () => void;
  readonly busy: boolean;
}) {
  return (
    <View className="gap-2 border-b border-accent bg-accent/10 px-3 py-3">
      <View className="min-w-0">
        <Text className="text-sm font-t3-bold text-foreground">Acode changes detected</Text>
        <Text className="mt-0.5 text-xs text-foreground-muted" numberOfLines={1}>
          {props.session.path}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {props.workspaceIdentity}
        </Text>
        <Text className="mt-1 text-xs font-t3-medium text-foreground-secondary">
          +{props.additions} / -{props.deletions} · review before writing to Workspace
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Pressable
          accessibilityLabel="View Acode diff"
          accessibilityRole="button"
          className="min-h-10 justify-center rounded-xl bg-subtle px-3 active:opacity-70 disabled:opacity-40"
          disabled={props.busy}
          onPress={props.onViewDiff}
        >
          <Text className="text-xs font-t3-bold text-foreground-secondary">View Diff</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Apply Acode changes to workspace"
          accessibilityRole="button"
          className="min-h-10 justify-center rounded-xl bg-primary px-3 active:opacity-70 disabled:opacity-40"
          disabled={props.busy}
          onPress={props.onApply}
        >
          <Text className="text-xs font-t3-bold text-primary-foreground">Apply to Workspace</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Discard Acode changes"
          accessibilityRole="button"
          className="min-h-10 justify-center rounded-xl bg-danger px-3 active:opacity-70 disabled:opacity-40"
          disabled={props.busy}
          onPress={props.onDiscard}
        >
          <Text className="text-xs font-t3-bold text-danger-foreground">Discard</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Check for Acode changes"
          accessibilityRole="button"
          className="min-h-10 justify-center rounded-xl px-2 active:bg-subtle disabled:opacity-40"
          disabled={props.busy}
          onPress={props.onCheck}
        >
          <Text className="text-xs font-t3-bold text-foreground-muted">Check again</Text>
        </Pressable>
      </View>
    </View>
  );
}

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function normalizeRoutePath(value: string | string[] | undefined): string | null {
  const path = Array.isArray(value) ? value.join("/") : value;
  if (path === undefined || path.trim().length === 0) {
    return null;
  }
  return path;
}

function normalizeRouteLine(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function defaultViewMode(path: string | null): FileViewMode {
  return path !== null &&
    (isWorkspaceBrowserPreviewPath(path) ||
      isWorkspaceImagePreviewPath(path) ||
      isVideoPreviewFile(path))
    ? "preview"
    : "source";
}

function FileContent(props: {
  readonly activeMode: FileViewMode;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly previewUri: string | null;
  readonly previewFailure: AssetUrlFailureReason | null;
  readonly onRetryPreview: () => void;
  readonly videoSource: MediaVideoPreviewSource | null;
  readonly mediaSource?: MediaActionsSource;
  readonly resolveVideoUri: () => Promise<string | null>;
  readonly fileContents: string | null;
  readonly fileError: string | null;
  readonly relativePath: string;
  readonly threadId: ThreadId;
  readonly initialLine: number | null;
  readonly truncated: boolean;
  readonly revision?: string;
  readonly onCancelEdit?: () => void;
  readonly onReloadLatest?: () => Promise<void> | void;
  readonly onSave?: (contents: string, overwrite: boolean) => Promise<WorkspaceEditorSaveResult>;
  readonly onRefresh?: () => Promise<void> | void;
}) {
  // Reopening a mutable host file must not reuse a poster from an earlier visit.
  const thumbnailInstanceId = useId();
  const isMarkdown = isMarkdownPreviewFile(props.relativePath);
  const isBrowserFile = isWorkspaceBrowserPreviewPath(props.relativePath);
  const isImageFile = isWorkspaceImagePreviewPath(props.relativePath);
  const isVideoFile = isVideoPreviewFile(props.relativePath);
  // Only the surfaces that wait on a signed asset URL can be blocked by one.
  const needsAssetUrl =
    isVideoFile || (props.activeMode === "preview" && (isImageFile || isBrowserFile));

  if (needsAssetUrl && props.previewFailure !== null) {
    return (
      <WorkspaceFilePreviewError
        environmentId={props.environmentId}
        reason={props.previewFailure}
        onRetry={props.onRetryPreview}
      />
    );
  }

  if (isVideoFile) {
    return (
      <WorkspaceFileVideoPreview
        name={basename(props.relativePath)}
        thumbnailKey={`workspace-video:${thumbnailInstanceId}`}
        uri={props.previewUri}
        source={props.videoSource}
        resolvePlaybackUri={props.resolveVideoUri}
      />
    );
  }

  if (
    props.activeMode === "edit" &&
    props.fileContents !== null &&
    props.revision !== undefined &&
    props.onCancelEdit !== undefined &&
    props.onReloadLatest !== undefined &&
    props.onSave !== undefined
  ) {
    return (
      <WorkspaceTextEditor
        contents={props.fileContents}
        initialLine={props.initialLine}
        path={props.relativePath}
        revision={props.revision}
        onCancel={props.onCancelEdit}
        onReloadLatest={props.onReloadLatest}
        onSave={props.onSave}
      />
    );
  }

  if (props.activeMode === "preview" && isImageFile) {
    if (isSvgImagePreviewFile(props.relativePath)) {
      return <WorkspaceFileWebPreview uri={props.previewUri} />;
    }
    return (
      <WorkspaceFileImagePreview
        accessibilityLabel={basename(props.relativePath)}
        uri={props.previewUri}
        actionsSource={props.mediaSource}
      />
    );
  }

  if (props.activeMode === "preview" && isBrowserFile) {
    return <WorkspaceFileWebPreview uri={props.previewUri} />;
  }

  if (props.fileError && props.fileContents === null) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <EmptyState title="File unavailable" detail={props.fileError} />
      </View>
    );
  }

  if (props.fileContents === null) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-sheet px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">Loading file...</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      {props.truncated ? (
        <View className="border-b border-warning-border bg-warning px-4 py-2">
          <Text className="text-2xs font-t3-bold uppercase text-warning-foreground">
            Partial file
          </Text>
          <Text className="text-xs leading-snug text-warning-foreground">
            Preview limited to the first 1 MB of a truncated file.
          </Text>
        </View>
      ) : null}
      {props.activeMode === "preview" && isMarkdown ? (
        <FileMarkdownPreview
          cwd={props.cwd}
          environmentId={props.environmentId}
          markdown={props.fileContents}
          relativePath={props.relativePath}
          threadId={props.threadId}
          onRefresh={props.onRefresh}
        />
      ) : (
        <SourceFileSurface
          contents={props.fileContents}
          path={props.relativePath}
          initialLine={props.initialLine}
          onRefresh={props.onRefresh}
        />
      )}
    </View>
  );
}

type ThreadFilesRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

type ThreadFileRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly path: string[];
  readonly line?: string;
}>;

function useThreadFilesWorkspace(params: {
  readonly environmentId?: string | string[];
  readonly threadId?: string | string[];
}) {
  const routeEnvironmentId = firstRouteParam(params.environmentId);
  const routeThreadId = firstRouteParam(params.threadId);
  const { selectedEnvironmentConnection, selectedThread, selectedThreadProject } =
    useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const environmentId =
    routeEnvironmentId !== null
      ? EnvironmentId.make(routeEnvironmentId)
      : (selectedThread?.environmentId ?? null);
  const threadId = routeThreadId !== null ? ThreadId.make(routeThreadId) : null;
  const project = selectedThreadProject as {
    readonly title?: string;
    readonly workspaceRoot?: string;
  } | null;

  return {
    cwd: selectedThreadCwd ?? project?.workspaceRoot ?? null,
    environmentId,
    environmentLabel: selectedEnvironmentConnection?.environmentLabel ?? "T3 host",
    projectName: project?.title ?? "Files",
    selectedThread,
    threadId,
  };
}

function SearchModeButton(props: {
  readonly active: boolean;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={`Search ${props.label.toLowerCase()}`}
      accessibilityRole="button"
      className={
        props.active
          ? "min-h-10 justify-center rounded-xl bg-accent px-4"
          : "min-h-10 justify-center rounded-xl bg-subtle px-4"
      }
      onPress={props.onPress}
    >
      <Text
        className={
          props.active
            ? "text-xs font-t3-bold text-accent-foreground"
            : "text-xs font-t3-bold text-foreground-secondary"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function FilesUnavailable() {
  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <NativeStackScreenOptions options={{ title: "Files" }} />
      <EmptyState
        title="Files unavailable"
        detail="This thread does not have an active workspace path."
      />
    </View>
  );
}

function FilesToolbarBottomFade() {
  const sheetColor = String(useUniwindTheme()["--color-sheet"]);

  if (process.env.EXPO_OS !== "ios") {
    return null;
  }

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-x-0 bottom-0 z-[1] h-28"
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="files-toolbar-bottom-fade" x1="0%" x2="0%" y1="0%" y2="100%">
            <Stop offset="0%" stopColor={sheetColor} stopOpacity={0} />
            <Stop offset="58%" stopColor={sheetColor} stopOpacity={0.72} />
            <Stop offset="100%" stopColor={sheetColor} stopOpacity={0.96} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#files-toolbar-bottom-fade)" />
      </Svg>
    </View>
  );
}

export function ThreadFilesTreeScreen(props: ThreadFilesRouteScreenProps) {
  useAdaptiveWorkspacePaneRole("inspector");
  const navigation = useNavigation();
  const { fileInspector, layout, panes, showAuxiliaryPane, togglePrimarySidebar } =
    useAdaptiveWorkspaceLayout();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"files" | "contents">("files");
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 250);
  const isAndroid = Platform.OS === "android";
  const { themeAppearance: highlightTheme } = useAppearancePreferences();
  const theme = useUniwindTheme();
  const sheetSurfaceColor = theme["--color-sheet-solid"];
  const { cwd, environmentId, environmentLabel, projectName, selectedThread, threadId } =
    useThreadFilesWorkspace(props.route.params);
  const workspaceIdentity = cwd === null ? environmentLabel : `${environmentLabel} - ${cwd}`;
  const preferences = useAtomValue(mobilePreferencesAtom);
  const recentFiles =
    AsyncResult.isSuccess(preferences) && environmentId !== null && cwd !== null
      ? (preferences.value.recentWorkspaceFiles ?? []).filter(
          (entry) => entry.environmentId === String(environmentId) && entry.cwd === cwd,
        )
      : [];
  const revealedInspectorRef = useRef(false);
  const entriesQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null && !fileInspector.supported
      ? projectEnvironment.listEntries({
          environmentId,
          input: { cwd },
        })
      : null,
  );
  const entriesData = entriesQuery.data as ProjectListEntriesResult | null;
  const writeWorkspaceFile = useAtomCommand(projectEnvironment.writeFile, {
    label: "workspace file upload",
    reportFailure: false,
  });
  const contentSearchQuery = useEnvironmentQuery(
    environmentId !== null &&
      cwd !== null &&
      searchMode === "contents" &&
      debouncedSearchQuery.length > 0
      ? projectEnvironment.searchContents({
          environmentId,
          input: {
            cwd,
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
  const handleUploadFile = useCallback(async () => {
    if (environmentId === null || cwd === null) return;
    try {
      const { getDocumentAsync } = await import("expo-document-picker");
      const picked = await getDocumentAsync({
        type: "text/*",
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled) return;
      const asset = picked.assets[0];
      if (asset === undefined) return;
      if ((asset.size ?? 0) > 1024 * 1024) {
        Alert.alert("File too large", "Mobile workspace upload is limited to 1 MB text files.");
        return;
      }
      if (entriesData?.entries.some((entry) => entry.path === asset.name)) {
        Alert.alert(
          "File already exists",
          `${asset.name} was not overwritten. Rename it on the phone or edit the host file in T3.`,
        );
        return;
      }
      const { File } = await import("expo-file-system");
      const contents = await new File(asset.uri).text();
      const result = await writeWorkspaceFile({
        environmentId,
        input: { cwd, relativePath: asset.name, contents, createOnly: true },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        throw failure instanceof Error ? failure : new Error("The host rejected the upload.");
      }
      await entriesQuery.refresh();
      Alert.alert("Uploaded", `${asset.name} was added to ${workspaceIdentity}.`);
    } catch (error) {
      Alert.alert(
        "Could not upload file",
        error instanceof Error ? error.message : "The selected Android file could not be uploaded.",
      );
    }
  }, [
    cwd,
    entriesData?.entries,
    entriesQuery,
    environmentId,
    workspaceIdentity,
    writeWorkspaceFile,
  ]);
  const handleReturnToThread = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    if (environmentId !== null && threadId !== null) {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: String(environmentId),
          threadId: String(threadId),
        }),
      );
    }
  }, [environmentId, navigation, threadId]);

  const handleSelectFile = useCallback(
    (path: string, line?: number) => {
      if (environmentId === null || threadId === null) {
        return;
      }
      const params = {
        environmentId: String(environmentId),
        threadId: String(threadId),
        path: path.split("/").filter((segment) => segment.length > 0),
        ...(line === undefined ? {} : { line: String(line) }),
      };
      const navigationAction = resolveFileSelectionNavigationAction({
        hasPersistentFileInspector: fileInspector.supported,
      });
      if (navigationAction === "replace") {
        navigation.dispatch(StackActions.replace("ThreadFile", params));
        return;
      }
      navigation.navigate("ThreadFile", params);
    },
    [environmentId, fileInspector.supported, navigation, threadId],
  );
  const renderInspector = useCallback(
    (headerInset: number) =>
      environmentId !== null && cwd !== null ? (
        <ThreadFileNavigatorPane
          cwd={cwd}
          environmentId={environmentId}
          headerInset={headerInset}
          projectName={workspaceIdentity}
          selectedPath={null}
          onSelectFile={handleSelectFile}
        />
      ) : null,
    [cwd, environmentId, handleSelectFile, workspaceIdentity],
  );
  const handlePreviewFile = useCallback(
    (relativePath: string) => {
      if (environmentId === null || cwd === null) {
        return;
      }
      preloadWorkspaceFileContents({
        cwd,
        environmentId,
        relativePath,
        theme: highlightTheme,
      });
    },
    [cwd, environmentId, highlightTheme],
  );
  useEffect(() => {
    if (fileInspector.supported && cwd !== null && !revealedInspectorRef.current) {
      revealedInspectorRef.current = true;
      showAuxiliaryPane("inspector");
    }
  }, [cwd, fileInspector.supported, showAuxiliaryPane]);

  if (selectedThread === null || environmentId === null || threadId === null) {
    if (fileInspector.supported) {
      return (
        <ThreadRouteScreen
          onReturnToThread={handleReturnToThread}
          renderInspector={renderInspector}
          route={props.route}
        />
      );
    }
    return <LoadingScreen message="Opening files..." messagePlacement="above-spinner" />;
  }

  if (cwd === null) {
    return <FilesUnavailable />;
  }

  if (fileInspector.supported) {
    return (
      <ThreadRouteScreen
        onReturnToThread={handleReturnToThread}
        renderInspector={renderInspector}
        route={props.route}
      />
    );
  }

  const usesCompactMailToolbar =
    Platform.OS === "ios" && !layout.usesSplitView && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;

  return (
    <>
      {/* Static header config (glass preset and title) lives in Stack.tsx. The
          live sheet color stays dynamic here so the FlatList can remain the
          direct scene child for native scroll-edge sampling. */}
      <NativeStackScreenOptions
        options={{
          contentStyle: { backgroundColor: sheetSurfaceColor },
          headerShown: !isAndroid,
          unstable_headerSubtitle:
            Platform.OS === "ios" && workspaceIdentity.length > 0 ? workspaceIdentity : undefined,
          // No refresh button: the list already supports pull-to-refresh.
          unstable_headerToolbarItems: usesCompactMailToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  onSearchTextChange: setSearchQuery,
                  placeholder: searchMode === "contents" ? "Search contents" : "Search files",
                  searchTextChangeId: "files-search-text",
                }),
              ]
            : undefined,
          headerSearchBarOptions: usesCompactMailToolbar
            ? undefined
            : {
                allowToolbarIntegration: true,
                autoCapitalize: "none",
                hideNavigationBar: false,
                placeholder: searchMode === "contents" ? "Search contents" : "Search files",
                onChangeText: (event) => {
                  setSearchQuery(event.nativeEvent.text);
                },
                onCancelButtonPress: () => {
                  setSearchQuery("");
                },
              },
        }}
      />
      {isAndroid ? (
        <>
          <AndroidScreenHeader
            title="Files"
            subtitle={workspaceIdentity}
            onBack={handleReturnToThread}
            actions={[
              {
                accessibilityLabel: "Upload text file to workspace",
                icon: "square.and.arrow.up",
                onPress: () => void handleUploadFile(),
              },
              {
                accessibilityLabel: "Refresh files",
                icon: "arrow.clockwise",
                onPress: entriesQuery.refresh,
              },
            ]}
          />
          <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
            <SymbolView
              name="magnifyingglass"
              size={17}
              tintColorClassName={"accent-icon-muted"}
              type="monochrome"
            />
            <TextInput
              accessibilityLabel={
                searchMode === "contents" ? "Search file contents" : "Search files"
              }
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-10 flex-1 rounded-xl py-2 text-sm"
              placeholder={searchMode === "contents" ? "Search contents" : "Search files"}
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
          </View>
        </>
      ) : (
        <>
          {layout.usesSplitView ? (
            <NativeHeaderToolbar placement="left">
              <NativeHeaderToolbar.Button
                accessibilityLabel={panes.primarySidebarVisible ? "Maximize files" : "Show threads"}
                icon={
                  panes.primarySidebarVisible
                    ? "arrow.up.left.and.arrow.down.right"
                    : "sidebar.left"
                }
                onPress={togglePrimarySidebar}
                separateBackground
              />
            </NativeHeaderToolbar>
          ) : null}
          {usesCompactMailToolbar ? null : (
            <NativeHeaderToolbar placement="bottom">
              <NativeHeaderToolbar.SearchBarSlot />
            </NativeHeaderToolbar>
          )}
        </>
      )}
      <View className="flex-row flex-wrap gap-2 border-b border-border px-3 py-2">
        <SearchModeButton
          active={searchMode === "files"}
          label="Files"
          onPress={() => setSearchMode("files")}
        />
        <SearchModeButton
          active={searchMode === "contents"}
          label="Contents"
          onPress={() => setSearchMode("contents")}
        />
        {recentFiles.slice(0, 2).map((entry) => (
          <Pressable
            key={entry.path}
            accessibilityLabel={`Open recent file ${entry.path}`}
            accessibilityRole="button"
            className="min-h-10 min-w-0 max-w-[45%] justify-center rounded-xl bg-subtle px-3"
            onPress={() => handleSelectFile(entry.path)}
          >
            <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
              {basename(entry.path)}
            </Text>
          </Pressable>
        ))}
      </View>
      {searchMode === "contents" ? (
        <ScrollView className="flex-1 bg-sheet" contentContainerClassName="gap-1 p-2">
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
                className="min-h-12 rounded-xl px-3 py-2 active:bg-subtle"
                onPress={() => handleSelectFile(match.path, match.lineNumber)}
              >
                <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
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
      ) : (
        <FileTreeBrowser
          entries={entriesData?.entries ?? []}
          error={entriesQuery.error}
          isPending={entriesQuery.isPending}
          searchQuery={searchQuery}
          selectedPath={null}
          onPreviewFile={handlePreviewFile}
          onRefresh={entriesQuery.refresh}
          onSelectFile={handleSelectFile}
        />
      )}
      <FilesToolbarBottomFade />
    </>
  );
}

export function ThreadFileScreen(props: ThreadFileRouteScreenProps) {
  useAdaptiveWorkspacePaneRole("inspector");
  const navigation = useNavigation();
  const { fileInspector, panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const iconColor = useUniwindTheme()["--color-icon"];
  const isAndroid = Platform.OS === "android";
  const params = props.route.params;
  const relativePath = normalizeRoutePath(params.path);
  const targetLine = normalizeRouteLine(firstRouteParam(params.line));
  const { cwd, environmentId, environmentLabel, projectName, selectedThread, threadId } =
    useThreadFilesWorkspace(props.route.params);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, {
    label: "workspace file save",
    reportFailure: false,
  });
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const recordedRecentKey = useRef<string | null>(null);
  const [modeOverride, setModeOverride] = useState<{
    readonly path: string;
    readonly mode: FileViewMode;
  } | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const previewKey = JSON.stringify([environmentId, cwd, relativePath, previewRevision]);
  const [fullScreenPreview, setFullScreenPreview] = useState<FilePreviewSource | null>(null);
  const isVideoFile = relativePath !== null && isVideoPreviewFile(relativePath);
  const isBrowserFile =
    relativePath !== null && !isVideoFile && isWorkspaceBrowserPreviewPath(relativePath);
  const isImageFile =
    relativePath !== null && !isVideoFile && isWorkspaceImagePreviewPath(relativePath);
  const canPreview =
    relativePath !== null &&
    (isMarkdownPreviewFile(relativePath) || isBrowserFile || isImageFile || isVideoFile);
  const activeMode =
    relativePath !== null && modeOverride?.path === relativePath
      ? modeOverride.mode
      : defaultViewMode(relativePath);
  const resolvedActiveMode = isVideoFile
    ? "preview"
    : activeMode === "edit"
      ? "edit"
      : canPreview
        ? activeMode
        : "source";
  const assetPreviewPath = isBrowserFile || isImageFile || isVideoFile ? relativePath : null;
  const assetPreview = useWorkspaceFileAssetUrlState({
    cwd,
    environmentId,
    relativePath: assetPreviewPath,
    threadId,
  });
  const assetPreviewUri = assetPreview._tag === "Success" ? assetPreview.url : null;
  const mediaSource = useMemo<MediaActionsSource | undefined>(
    () =>
      environmentId !== null &&
      threadId !== null &&
      relativePath !== null &&
      assetPreview.resource !== null &&
      "path" in assetPreview.resource &&
      typeof assetPreview.resource.path === "string" &&
      (isImageFile || isVideoFile)
        ? {
            reference: mediaFileReference(assetPreview.resource.path, cwd),
            name: basename(relativePath),
            mimeType:
              mediaMimeTypeFromExtension(relativePath.slice(relativePath.lastIndexOf("."))) ??
              "application/octet-stream",
            environmentId,
            threadId,
            resource: assetPreview.resource,
          }
        : undefined,
    [assetPreview.resource, cwd, environmentId, isImageFile, isVideoFile, relativePath, threadId],
  );
  const mediaActions = useMediaActions(mediaSource);
  const videoSource = useMemo<MediaVideoPreviewSource | null>(
    () =>
      environmentId !== null &&
      relativePath !== null &&
      assetPreview.resource?._tag === "media-file"
        ? {
            type: "media",
            environmentId,
            resource: assetPreview.resource,
            name: basename(relativePath),
            mimeType: videoMimeType({ name: relativePath, mimeType: "" }) ?? "video/mp4",
            actionsSource: mediaSource,
          }
        : null,
    [assetPreview.resource, environmentId, relativePath, mediaSource],
  );
  const previewUri =
    assetPreviewUri === null || previewRevision === 0
      ? assetPreviewUri
      : `${assetPreviewUri}${assetPreviewUri.includes("?") ? "&" : "?"}revision=${previewRevision}`;
  // Remounting the preview after a re-mint is what makes a failed asset URL retryable.
  const handleRetryPreview = () => {
    void assetPreview.refresh().finally(() => setPreviewRevision((current) => current + 1));
  };
  const needsFileContents =
    relativePath !== null &&
    !isVideoFile &&
    (resolvedActiveMode === "source" ||
      resolvedActiveMode === "edit" ||
      isMarkdownPreviewFile(relativePath));
  const fileQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null && relativePath !== null && needsFileContents
      ? projectEnvironment.readFile({
          environmentId,
          input: { cwd, relativePath },
        })
      : null,
  );
  const fileData = fileQuery.data as ProjectReadFileResult | null;
  const canEdit =
    fileData !== null &&
    fileData.truncated === false &&
    fileData.byteLength <= MAX_MOBILE_EDIT_BYTES &&
    fileData.contents.split("\n").length <= MAX_MOBILE_EDIT_LINES &&
    fileData.revision !== undefined &&
    !isImageFile &&
    !isBrowserFile;
  const savePreferencesAsync = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const [externalEditSessions, setExternalEditSessions] = useState<
    ReadonlyArray<MobileExternalEditSession>
  >([]);
  const externalEditSessionsRef = useRef<ReadonlyArray<MobileExternalEditSession>>([]);
  const externalEditSessionsInitializedRef = useRef(false);
  const [pendingExternalEdit, setPendingExternalEdit] = useState<PendingExternalEdit | null>(null);
  const [externalEditReviewVisible, setExternalEditReviewVisible] = useState(false);
  const [externalEditConflict, setExternalEditConflict] = useState(false);
  const [externalEditBusy, setExternalEditBusy] = useState(false);

  const commitExternalEditSessions = useCallback(
    async (next: ReadonlyArray<MobileExternalEditSession>) => {
      await savePreferencesAsync({ externalEditSessions: next });
      externalEditSessionsRef.current = next;
      setExternalEditSessions(next);
    },
    [savePreferencesAsync],
  );

  useEffect(() => {
    if (!AsyncResult.isSuccess(preferences) || externalEditSessionsInitializedRef.current) {
      return;
    }
    externalEditSessionsInitializedRef.current = true;
    const loaded = preferences.value.externalEditSessions ?? [];
    externalEditSessionsRef.current = loaded;
    setExternalEditSessions(loaded);
    void (async () => {
      const now = Date.now();
      const pruned = prunePreparingExternalEditSessions(loaded, now);
      if (pruned.expiredSnapshotIds.length > 0) {
        await Promise.all(
          pruned.expiredSnapshotIds.map(async (snapshotId) => {
            try {
              await removeExternalEditSnapshot(snapshotId);
            } catch {
              // The record is still safe to remove; a conservative orphan scan
              // can clean a leftover preparing file later.
            }
          }),
        );
        try {
          await commitExternalEditSessions(pruned.sessions);
        } catch {
          // Keep the in-memory record until the next screen load if persistence
          // is unavailable. No host file is touched by this cleanup.
        }
      }
      try {
        await cleanupExternalEditSnapshots(
          new Set(pruned.sessions.map((session) => session.snapshotId)),
          now,
        );
      } catch {
        // Cleanup is best effort and never participates in host writes.
      }
    })();
  }, [commitExternalEditSessions, preferences]);

  const externalEditTarget =
    environmentId !== null && cwd !== null && relativePath !== null
      ? { environmentId: String(environmentId), cwd, path: relativePath }
      : null;
  const currentExternalEditSession =
    externalEditTarget === null
      ? undefined
      : findExternalEditSession(externalEditSessions, externalEditTarget);

  const updateExternalEditSession = useCallback(
    async (
      snapshotId: string,
      update: (session: MobileExternalEditSession) => MobileExternalEditSession,
    ) => {
      const current = externalEditSessionsRef.current;
      const existing = current.find((session) => session.snapshotId === snapshotId);
      if (existing === undefined) return undefined;
      const updated = update(existing);
      await commitExternalEditSessions(
        current.map((session) => (session.snapshotId === snapshotId ? updated : session)),
      );
      return updated;
    },
    [commitExternalEditSessions],
  );

  const checkExternalEditChanges = useCallback(async () => {
    const session = currentExternalEditSession;
    if (session === undefined) return false;
    let snapshot: Awaited<ReturnType<typeof readExternalEditSnapshot>>;
    try {
      snapshot = await readExternalEditSnapshot(session.snapshotId);
    } catch (error) {
      Alert.alert(
        "Acode snapshot unavailable",
        error instanceof Error
          ? error.message
          : "The external edit was kept, but its Android snapshot could not be read.",
      );
      return false;
    }
    const comparison = compareExternalEditSnapshot({
      session,
      originalContents: snapshot.originalContents,
      snapshotContents: snapshot.snapshotContents,
      now: Date.now(),
    });
    let updatedSession: MobileExternalEditSession | undefined;
    try {
      updatedSession = await updateExternalEditSession(
        session.snapshotId,
        () => comparison.session,
      );
    } catch (error) {
      Alert.alert(
        "Could not record Acode changes",
        error instanceof Error
          ? error.message
          : "The external edit is still preserved on this device.",
      );
      return false;
    }
    if (updatedSession === undefined) return false;
    if (comparison.changed) {
      setPendingExternalEdit({
        session: updatedSession,
        originalContents: snapshot.originalContents,
        snapshotContents: snapshot.snapshotContents,
      });
    } else {
      setPendingExternalEdit((pending) =>
        pending?.session.snapshotId === session.snapshotId ? null : pending,
      );
      setExternalEditConflict(false);
    }
    return comparison.changed;
  }, [currentExternalEditSession, updateExternalEditSession]);

  const externalEditCheckRef = useRef(checkExternalEditChanges);
  externalEditCheckRef.current = checkExternalEditChanges;
  useFocusEffect(
    useCallback(() => {
      void externalEditCheckRef.current();
    }, []),
  );
  useEffect(() => {
    if (!isAndroid) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void externalEditCheckRef.current();
    });
    return () => subscription.remove();
  }, [isAndroid]);

  useEffect(() => {
    if (
      environmentId === null ||
      cwd === null ||
      relativePath === null ||
      fileData === null ||
      !AsyncResult.isSuccess(preferences)
    )
      return;
    const key = JSON.stringify([String(environmentId), cwd, relativePath]);
    if (recordedRecentKey.current === key) return;
    recordedRecentKey.current = key;
    savePreferences({
      recentWorkspaceFiles: recordRecentWorkspaceFile(
        preferences.value.recentWorkspaceFiles ?? [],
        {
          environmentId: String(environmentId),
          cwd,
          path: relativePath,
        },
      ),
    });
  }, [cwd, environmentId, fileData, preferences, relativePath, savePreferences]);

  const handleSave = useCallback(
    async (contents: string, overwrite: boolean): Promise<WorkspaceEditorSaveResult> => {
      if (
        environmentId === null ||
        cwd === null ||
        relativePath === null ||
        fileData?.revision === undefined
      ) {
        return { status: "failed", message: "The workspace target is no longer available." };
      }
      const result = await writeFile({
        environmentId,
        input: {
          cwd,
          relativePath,
          contents,
          expectedRevision: fileData.revision,
          overwrite,
        },
      });
      if (result._tag === "Success") {
        if (result.value.revision === undefined) {
          return { status: "failed", message: "The host did not confirm the saved revision." };
        }
        void fileQuery.refresh();
        return { status: "saved", revision: result.value.revision };
      }
      const failure = squashAtomCommandFailure(result);
      if (
        typeof failure === "object" &&
        failure !== null &&
        "failure" in failure &&
        failure.failure === "file_conflict"
      ) {
        return { status: "conflict" };
      }
      return {
        status: "failed",
        message: failure instanceof Error ? failure.message : "The host could not save this file.",
      };
    },
    [cwd, environmentId, fileData?.revision, fileQuery, relativePath, writeFile],
  );

  const cacheCurrentFile = useCallback(async () => {
    if (relativePath === null || fileData === null || fileData.truncated) {
      throw new Error("Only complete text files can be handed to another Android app.");
    }
    return cacheWorkspaceTextFile({ path: relativePath, contents: fileData.contents });
  }, [fileData, relativePath]);

  const prepareExternalEdit = useCallback(
    async (editor: "acode" | "system") => {
      if (
        externalEditTarget === null ||
        fileData === null ||
        fileData.truncated ||
        fileData.revision === undefined
      ) {
        throw new Error("Only complete text files with a host revision can be edited externally.");
      }
      const now = Date.now();
      const existing = findExternalEditSession(externalEditSessionsRef.current, externalEditTarget);
      if (existing !== undefined) {
        const snapshot = await readExternalEditSnapshot(existing.snapshotId);
        const opened = {
          ...existing,
          snapshotUri: snapshot.snapshotUri,
          contentUri: existing.contentUri,
          state: "open" as const,
          lastOpenedAt: now,
        };
        if (
          opened.snapshotUri !== existing.snapshotUri ||
          opened.state !== existing.state ||
          opened.lastOpenedAt !== existing.lastOpenedAt
        ) {
          await updateExternalEditSession(existing.snapshotId, () => opened);
        }
        return opened;
      }
      if (externalEditSessionsRef.current.length >= MAX_EXTERNAL_EDIT_SESSIONS) {
        throw new Error("Review or discard an existing external edit before opening another.");
      }

      const snapshotId = uuidv4();
      let persisted = false;
      try {
        const snapshot = await createExternalEditSnapshot({
          snapshotId,
          contents: fileData.contents,
        });
        const preparing = createExternalEditSession({
          snapshotId,
          snapshotUri: snapshot.snapshotUri,
          contentUri: snapshot.contentUri,
          target: externalEditTarget,
          originalRevision: fileData.revision,
          editor,
          now,
        });
        await commitExternalEditSessions([...externalEditSessionsRef.current, preparing]);
        persisted = true;
        const opened = markExternalEditOpened(preparing, now);
        await updateExternalEditSession(snapshotId, () => opened);
        return opened;
      } catch (error) {
        try {
          await removeExternalEditSnapshot(snapshotId);
        } catch {
          // The preparing record or conservative orphan cleanup retains any
          // incomplete snapshot when local deletion is unavailable.
        }
        if (persisted) {
          try {
            await commitExternalEditSessions(
              removeExternalEditSession(externalEditSessionsRef.current, snapshotId),
            );
          } catch {
            // Do not mask the launch failure with a best-effort metadata cleanup.
          }
        }
        throw error;
      }
    },
    [commitExternalEditSessions, externalEditTarget, fileData, updateExternalEditSession],
  );

  const launchExternal = useCallback(
    async (
      kind: "acode" | "system" | "solid-explorer",
      editable = kind !== "solid-explorer",
      trackExternalEdit = editable && (kind === "acode" || kind === "system"),
    ) => {
      if (relativePath === null) return;
      try {
        const target = resolveExternalAppPackage(kind, isExternalPackageInstalled);
        if (target.status === "unavailable") {
          Alert.alert(
            kind === "acode" ? "Acode unavailable" : "Solid Explorer unavailable",
            "The selected app is not installed. Choose the system handler instead.",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Use system",
                onPress: () => void launchExternal("system", editable, trackExternalEdit),
              },
            ],
          );
          return;
        }
        const { packageName } = target;
        const uri =
          isAndroid && trackExternalEdit
            ? (await prepareExternalEdit(kind === "acode" ? "acode" : "system")).snapshotUri
            : await cacheCurrentFile();
        await openExternalFile({
          uri,
          mimeType: workspaceFileMimeType(relativePath),
          packageName,
          editable,
          forceChooser: kind === "system",
          chooserTitle: kind === "solid-explorer" ? "Open file" : "Open code file",
        });
      } catch (error) {
        Alert.alert(
          "Could not open externally",
          error instanceof Error
            ? error.message
            : "No compatible Android app accepted the file. The external edit was preserved when possible.",
        );
      }
    },
    [cacheCurrentFile, isAndroid, prepareExternalEdit, relativePath],
  );

  const discardExternalEdit = useCallback(
    async (snapshotId?: string) => {
      const session =
        (snapshotId === undefined
          ? (pendingExternalEdit?.session ?? currentExternalEditSession)
          : externalEditSessionsRef.current.find((entry) => entry.snapshotId === snapshotId)) ??
        undefined;
      if (session === undefined) return;
      setExternalEditBusy(true);
      try {
        await removeExternalEditSnapshot(session.snapshotId);
        await commitExternalEditSessions(
          removeExternalEditSession(externalEditSessionsRef.current, session.snapshotId),
        );
        setPendingExternalEdit((pending) =>
          pending?.session.snapshotId === session.snapshotId ? null : pending,
        );
        setExternalEditReviewVisible(false);
        setExternalEditConflict(false);
      } catch (error) {
        Alert.alert(
          "Could not discard Acode edit",
          error instanceof Error
            ? error.message
            : "The external edit was kept and the host file was not changed.",
        );
      } finally {
        setExternalEditBusy(false);
      }
    },
    [commitExternalEditSessions, currentExternalEditSession, pendingExternalEdit],
  );

  const applyExternalEdit = useCallback(
    async (overwrite = false) => {
      const session = currentExternalEditSession;
      if (session === undefined) return;
      setExternalEditBusy(true);
      let hostWriteSucceeded = false;
      try {
        const snapshot = await readExternalEditSnapshot(session.snapshotId);
        const comparison = compareExternalEditSnapshot({
          session,
          originalContents: snapshot.originalContents,
          snapshotContents: snapshot.snapshotContents,
          now: Date.now(),
        });
        const updatedSession = await updateExternalEditSession(
          session.snapshotId,
          () => comparison.session,
        );
        if (updatedSession === undefined) {
          throw new Error("The external edit session is no longer available.");
        }
        if (!comparison.changed) {
          setPendingExternalEdit((pending) =>
            pending?.session.snapshotId === session.snapshotId ? null : pending,
          );
          setExternalEditConflict(false);
          setExternalEditReviewVisible(false);
          return;
        }
        setPendingExternalEdit({
          session: updatedSession,
          originalContents: snapshot.originalContents,
          snapshotContents: snapshot.snapshotContents,
        });

        const result = await writeFile({
          environmentId: EnvironmentId.make(updatedSession.environmentId),
          input: buildExternalEditWriteInput(updatedSession, snapshot.snapshotContents, overwrite),
        });
        if (result._tag === "Failure") {
          const failure = squashAtomCommandFailure(result);
          if (
            typeof failure === "object" &&
            failure !== null &&
            "failure" in failure &&
            failure.failure === "file_conflict"
          ) {
            setExternalEditConflict(true);
            setExternalEditReviewVisible(true);
            return;
          }
          throw failure instanceof Error
            ? failure
            : new Error("The host rejected the external edit.");
        }
        if (result.value.revision === undefined) {
          throw new Error("The host did not confirm the saved revision.");
        }
        hostWriteSucceeded = true;
        try {
          await fileQuery.refresh();
        } catch {
          // The authenticated host write already succeeded. Keep the success
          // result truthful even if this screen cannot refresh immediately.
        }

        let cleanupMessage: string | null = null;
        try {
          await removeExternalEditSnapshot(updatedSession.snapshotId);
          try {
            await commitExternalEditSessions(
              removeExternalEditSession(externalEditSessionsRef.current, updatedSession.snapshotId),
            );
          } catch {
            cleanupMessage =
              "The host was updated, but T3 could not finish removing the saved Acode session.";
          }
        } catch {
          cleanupMessage =
            "The host was updated, but T3 could not remove the saved Acode snapshot yet.";
        }
        setPendingExternalEdit((pending) =>
          pending?.session.snapshotId === updatedSession.snapshotId ? null : pending,
        );
        setExternalEditReviewVisible(false);
        setExternalEditConflict(false);
        Alert.alert(
          "Applied to Workspace",
          cleanupMessage ?? `${updatedSession.path} was updated on the host.`,
        );
      } catch (error) {
        Alert.alert(
          hostWriteSucceeded ? "Applied to Workspace" : "Could not apply Acode edit",
          hostWriteSucceeded
            ? "The host file was updated, but T3 could not finish the local refresh or cleanup. The external edit was preserved where possible."
            : error instanceof Error
              ? error.message
              : "The host file was not changed. The external edit was preserved.",
        );
      } finally {
        setExternalEditBusy(false);
      }
    },
    [
      commitExternalEditSessions,
      currentExternalEditSession,
      fileQuery,
      updateExternalEditSession,
      writeFile,
    ],
  );

  const pendingExternalEditDiff = useMemo(
    () =>
      pendingExternalEdit === null
        ? null
        : buildExternalEditDiff(
            pendingExternalEdit.originalContents,
            pendingExternalEdit.snapshotContents,
          ),
    [pendingExternalEdit],
  );

  const reviewLatestHostFile = useCallback(() => {
    setExternalEditConflict(false);
    setExternalEditReviewVisible(false);
    void fileQuery.refresh();
  }, [fileQuery]);

  const useHostAndDiscardExternalEdit = useCallback(() => {
    setExternalEditConflict(false);
    void discardExternalEdit();
  }, [discardExternalEdit]);

  const overwriteExternalEdit = useCallback(() => {
    void applyExternalEdit(true);
  }, [applyExternalEdit]);

  useEffect(() => {
    if (
      pendingExternalEdit !== null &&
      currentExternalEditSession?.snapshotId !== pendingExternalEdit.session.snapshotId
    ) {
      setPendingExternalEdit(null);
      setExternalEditReviewVisible(false);
      setExternalEditConflict(false);
    }
  }, [currentExternalEditSession?.snapshotId, pendingExternalEdit]);

  const handleExternalEditor = useCallback(() => {
    const preference = AsyncResult.isSuccess(preferences)
      ? (preferences.value.externalCodeEditor ?? "t3")
      : "t3";
    if (preference === "t3") {
      if (canEdit && relativePath !== null) setModeOverride({ path: relativePath, mode: "edit" });
      return;
    }
    const open = (kind: "acode" | "system") => {
      Alert.alert(
        "Open a file snapshot?",
        "Acode edits are saved to a bounded Android snapshot. T3 will ask you to review them before writing back to the Windows workspace.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open snapshot", onPress: () => void launchExternal(kind) },
        ],
      );
    };
    if (preference === "ask") {
      if (canEdit && relativePath !== null) {
        Alert.alert("Open code file", relativePath, [
          {
            text: "T3",
            onPress: () => setModeOverride({ path: relativePath, mode: "edit" }),
          },
          { text: "Acode", onPress: () => open("acode") },
          {
            text: "More",
            onPress: () =>
              Alert.alert("Open code file", relativePath, [
                { text: "System", onPress: () => open("system") },
                { text: "Cancel", style: "cancel" },
              ]),
          },
        ]);
      } else {
        Alert.alert("Open code file", relativePath ?? "Workspace file", [
          { text: "Acode", onPress: () => open("acode") },
          { text: "System", onPress: () => open("system") },
          { text: "Cancel", style: "cancel" },
        ]);
      }
      return;
    }
    open(preference);
  }, [canEdit, launchExternal, preferences, relativePath]);

  const handleExternalExplorer = useCallback(() => {
    const preference = AsyncResult.isSuccess(preferences)
      ? (preferences.value.externalFileExplorer ?? "system")
      : "system";
    if (preference === "ask") {
      Alert.alert("Open with file explorer", "Choose an Android file handler.", [
        {
          text: "Solid Explorer",
          onPress: () => void launchExternal("solid-explorer", false, false),
        },
        { text: "System", onPress: () => void launchExternal("system", true, false) },
        { text: "Cancel", style: "cancel" },
      ]);
      return;
    }
    void launchExternal(preference, preference !== "solid-explorer", false);
  }, [launchExternal, preferences]);

  const handleShareFile = useCallback(async () => {
    if (relativePath === null) return;
    try {
      const uri = await cacheCurrentFile();
      await shareLocalAttachment({
        uri,
        attachment: {
          name: basename(relativePath),
          mimeType: workspaceFileMimeType(relativePath),
        },
        signal: new AbortController().signal,
      });
    } catch (error) {
      Alert.alert(
        "Could not share file",
        error instanceof Error ? error.message : "The workspace file could not be prepared.",
      );
    }
  }, [cacheCurrentFile, relativePath]);

  const handleSelectFile = useCallback(
    (path: string, line?: number) => {
      navigation.navigate("ThreadFile", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        path: path.split("/").filter(Boolean),
        ...(line === undefined ? {} : { line: String(line) }),
      });
    },
    [environmentId, navigation, threadId],
  );
  const renderInspector = useCallback(
    (headerInset: number) =>
      fileInspector.supported && environmentId !== null && cwd !== null ? (
        <ThreadFileNavigatorPane
          cwd={cwd}
          environmentId={environmentId}
          headerInset={headerInset}
          projectName={`${environmentLabel} - ${cwd}`}
          selectedPath={relativePath}
          onSelectFile={handleSelectFile}
        />
      ) : undefined,
    [cwd, environmentId, environmentLabel, fileInspector.supported, handleSelectFile, relativePath],
  );
  // The workspace inspector column spans the full window height. On iOS the
  // pane brings its own nested native header; elsewhere it pads itself below
  // the top inset.
  const safeAreaInsets = useSafeAreaInsets();
  const inspectorHeaderInset = Platform.OS === "ios" ? 0 : safeAreaInsets.top;
  // Hand the file navigator to the workspace so it renders beside the
  // navigator, outside this screen's native header.
  const renderWorkspaceInspector = useCallback(
    () => renderInspector(inspectorHeaderInset),
    [inspectorHeaderInset, renderInspector],
  );
  useRegisterWorkspaceInspector(fileInspector.supported ? renderWorkspaceInspector : undefined);

  const fileMenuActions = useMemo(() => {
    if (relativePath === null) return [];
    const canToggleMode =
      canPreview && !isImageFile && !isVideoFile && resolvedActiveMode !== "edit";
    return [
      canEdit && resolvedActiveMode !== "edit"
        ? ({
            id: "edit",
            title: "Edit in T3",
            icon: "square.and.pencil",
            inline: true,
            onPress: () => setModeOverride({ path: relativePath, mode: "edit" }),
          } as const)
        : null,
      canToggleMode
        ? ({
            id: "preview",
            title: "Preview",
            icon: "eye",
            inline: true,
            onPress: () => setModeOverride({ path: relativePath, mode: "preview" }),
          } as const)
        : null,
      canToggleMode
        ? ({
            id: "source",
            title: "Source",
            icon: "doc.text",
            inline: true,
            onPress: () => setModeOverride({ path: relativePath, mode: "source" }),
          } as const)
        : null,
      ...(mediaSource
        ? mediaActions.actions
            .filter(({ id }) => id !== "open-file")
            .map((action) => ({
              id: action.id,
              title: action.title,
              icon:
                action.id === "save" ? ("square.and.arrow.up" as const) : ("doc.on.doc" as const),
              inline: false,
              onPress: action.run,
            }))
        : []),
      {
        id: "copy-workspace-path",
        title: "Copy workspace path",
        icon: "doc.on.doc",
        inline: false,
        onPress: () => {
          if (cwd !== null) copyTextWithHaptic(hostWorkspaceFilePath(cwd, relativePath));
        },
      } as const,
      currentExternalEditSession !== undefined
        ? ({
            id: "check-acode-changes",
            title: "Check for Acode changes",
            icon: "arrow.clockwise",
            inline: false,
            onPress: () => void checkExternalEditChanges(),
          } as const)
        : null,
      fileData !== null
        ? ({
            id: "external-editor",
            title: "Open with code editor",
            icon: "arrow.up.right",
            inline: false,
            onPress: handleExternalEditor,
          } as const)
        : null,
      fileData !== null
        ? ({
            id: "external-explorer",
            title: "Open with file explorer",
            icon: "folder",
            inline: false,
            onPress: handleExternalExplorer,
          } as const)
        : null,
      fileData !== null && mediaSource === undefined
        ? ({
            id: "share",
            title: "Save or share",
            icon: "square.and.arrow.up",
            inline: false,
            onPress: handleShareFile,
          } as const)
        : null,
      isPdfFile({ name: relativePath }) && previewUri !== null
        ? ({
            id: "open-pdf",
            title: "Open PDF",
            icon: "arrow.up.left.and.arrow.down.right",
            inline: false,
            onPress: () =>
              setFullScreenPreview({
                kind: "pdf",
                uri: previewUri,
                name: basename(relativePath),
              }),
          } as const)
        : null,
      isBrowserFile && typeof assetPreviewUri === "string"
        ? ({
            id: "open-browser",
            title: Platform.OS === "ios" ? "Open in Safari" : "Open in browser",
            icon: "safari",
            inline: false,
            onPress: () => tryOpenExternalUrl(assetPreviewUri, "file-preview"),
          } as const)
        : null,
      resolvedActiveMode === "preview" && (isBrowserFile || isImageFile || isVideoFile)
        ? ({
            id: "refresh",
            title: "Refresh",
            icon: "arrow.clockwise",
            inline: false,
            onPress: async () => {
              if (isVideoFile) await assetPreview.refresh();
              setPreviewRevision((current) => current + 1);
            },
          } as const)
        : null,
    ].filter((action) => action !== null);
  }, [
    assetPreviewUri,
    assetPreview.refresh,
    previewUri,
    canEdit,
    canPreview,
    checkExternalEditChanges,
    cwd,
    currentExternalEditSession,
    fileData,
    handleExternalEditor,
    handleExternalExplorer,
    handleShareFile,
    isBrowserFile,
    isImageFile,
    isVideoFile,
    relativePath,
    resolvedActiveMode,
    mediaSource,
    mediaActions.actions,
  ]);

  const androidFileMenuActions = useMemo<MenuAction[]>(
    () =>
      fileMenuActions.map((action) => ({
        id: action.id,
        title: action.title,
        image: action.icon,
        state: action.id === resolvedActiveMode ? "on" : undefined,
      })),
    [fileMenuActions, resolvedActiveMode],
  );
  const handleAndroidFileMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const action = fileMenuActions.find(({ id }) => id === event.nativeEvent.event);
      void action?.onPress();
    },
    [fileMenuActions],
  );
  const handleReturnToThread = useCallback(() => {
    if (environmentId !== null && threadId !== null) {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: String(environmentId),
          threadId: String(threadId),
        }),
      );
    }
  }, [environmentId, navigation, threadId]);
  const handleBack = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    handleReturnToThread();
  }, [handleReturnToThread, navigation]);

  if (selectedThread === null || environmentId === null || threadId === null) {
    return <LoadingScreen message="Opening file..." messagePlacement="above-spinner" />;
  }

  if (cwd === null) {
    return <FilesUnavailable />;
  }

  if (relativePath === null) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <NativeStackScreenOptions options={{ title: "Files" }} />
        <EmptyState title="File unavailable" detail="This file path is invalid." />
      </View>
    );
  }

  const parentDir = relativePath.slice(
    0,
    Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"), 0),
  );
  // A host file outside the workspace is not under the project name.
  const headerSubtitle = isAbsolutePath(relativePath)
    ? parentDir
    : [projectName, parentDir].filter(Boolean).join(" · ");

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          // Static header config lives in Stack.tsx (SOLID_HEADER_OPTIONS: solid
          // sheet-colored header — this route's content scrolls internally, so
          // there is nothing for glass to sample). Only dynamic values here.
          headerShown: !isAndroid,
          headerTintColor: iconColor,
          headerTitle: basename(relativePath),
          title: basename(relativePath),
          unstable_headerSubtitle:
            Platform.OS === "ios" && headerSubtitle.length > 0 ? headerSubtitle : undefined,
        }}
      />
      {isAndroid ? (
        <AndroidScreenHeader
          title={basename(relativePath)}
          subtitle={headerSubtitle}
          onBack={handleBack}
          trailing={
            <>
              {fileInspector.supported ? (
                <AndroidHeaderIconButton
                  accessibilityLabel={
                    panes.auxiliaryPaneVisible ? "Hide file navigator" : "Show file navigator"
                  }
                  icon="sidebar.right"
                  onPress={toggleAuxiliaryPane}
                />
              ) : null}
              <ControlPillMenu
                actions={androidFileMenuActions}
                isAnchoredToRight
                title="File actions"
                onPressAction={handleAndroidFileMenuAction}
              >
                <AndroidHeaderIconButton accessibilityLabel="File actions" icon="ellipsis" />
              </ControlPillMenu>
            </>
          }
        />
      ) : null}
      <WorkspaceSidebarToolbar>
        {fileInspector.supported ? (
          <NativeHeaderToolbar.Button
            accessibilityLabel="Return to chat"
            icon="chevron.left"
            onPress={handleReturnToThread}
          />
        ) : null}
      </WorkspaceSidebarToolbar>
      <NativeHeaderToolbar placement="right">
        {fileInspector.supported ? (
          <NativeHeaderToolbar.Button
            accessibilityLabel={
              panes.auxiliaryPaneVisible ? "Hide file navigator" : "Show file navigator"
            }
            icon="sidebar.right"
            onPress={toggleAuxiliaryPane}
            separateBackground
          />
        ) : null}
        <NativeHeaderToolbar.Menu accessibilityLabel="File actions" icon="ellipsis">
          {fileMenuActions.some(({ inline }) => inline) ? (
            <NativeHeaderToolbar.Menu inline>
              {fileMenuActions
                .filter(({ inline }) => inline)
                .map((action) => (
                  <NativeHeaderToolbar.MenuAction
                    key={action.id}
                    icon={action.icon}
                    isOn={action.id === resolvedActiveMode}
                    onPress={action.onPress}
                  >
                    {action.title}
                  </NativeHeaderToolbar.MenuAction>
                ))}
            </NativeHeaderToolbar.Menu>
          ) : null}
          {fileMenuActions
            .filter(({ inline }) => !inline)
            .map((action) => (
              <NativeHeaderToolbar.MenuAction
                key={action.id}
                icon={action.icon}
                onPress={action.onPress}
              >
                {action.title}
              </NativeHeaderToolbar.MenuAction>
            ))}
        </NativeHeaderToolbar.Menu>
      </NativeHeaderToolbar>
      {pendingExternalEdit !== null && pendingExternalEditDiff !== null ? (
        <AcodeEditBanner
          additions={pendingExternalEditDiff.additions}
          busy={externalEditBusy}
          deletions={pendingExternalEditDiff.deletions}
          session={pendingExternalEdit.session}
          workspaceIdentity={`${environmentLabel} - ${cwd}`}
          onApply={() => void applyExternalEdit(false)}
          onCheck={() => void checkExternalEditChanges()}
          onDiscard={() => void discardExternalEdit(pendingExternalEdit.session.snapshotId)}
          onViewDiff={() => setExternalEditReviewVisible(true)}
        />
      ) : null}
      <FileContent
        key={previewKey}
        activeMode={resolvedActiveMode}
        cwd={cwd}
        environmentId={environmentId}
        previewUri={previewUri}
        previewFailure={assetPreview._tag === "Failure" ? assetPreview.reason : null}
        onRetryPreview={handleRetryPreview}
        videoSource={videoSource}
        mediaSource={mediaSource}
        resolveVideoUri={assetPreview.refresh}
        fileContents={fileData?.contents ?? null}
        fileError={fileQuery.error}
        initialLine={targetLine}
        relativePath={relativePath}
        threadId={threadId}
        truncated={fileData?.truncated ?? false}
        revision={fileData?.revision}
        onCancelEdit={() => setModeOverride({ path: relativePath, mode: "source" })}
        onReloadLatest={async () => {
          setModeOverride({ path: relativePath, mode: "source" });
          await fileQuery.refresh();
        }}
        onSave={handleSave}
        onRefresh={() => fileQuery.refresh()}
      />
      <FilePreviewModal
        source={fullScreenPreview}
        onRequestClose={() => setFullScreenPreview(null)}
      />
      {pendingExternalEdit !== null && pendingExternalEditDiff !== null ? (
        <AcodeEditReviewSheet
          applying={externalEditBusy}
          conflict={externalEditConflict}
          diff={pendingExternalEditDiff}
          path={pendingExternalEdit.session.path}
          visible={externalEditReviewVisible}
          onApply={() => void applyExternalEdit(false)}
          onClose={() => {
            setExternalEditReviewVisible(false);
            setExternalEditConflict(false);
          }}
          onDiscard={() => void discardExternalEdit(pendingExternalEdit.session.snapshotId)}
          onOverwrite={overwriteExternalEdit}
          onReviewLatest={reviewLatestHostFile}
          onUseHost={useHostAndDiscardExternalEdit}
        />
      ) : null}
    </View>
  );
}
