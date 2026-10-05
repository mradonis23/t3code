import type {
  EnvironmentId,
  SidebarProjectGroupingMode,
  SidebarThreadSortOrder,
  SidebarThreadVisibility,
} from "@t3tools/contracts";
import {
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
  DEFAULT_SIDEBAR_THREAD_VISIBILITY,
} from "@t3tools/contracts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type Dispatch,
  type SetStateAction,
} from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import type { HomeProjectSortOrder } from "./homeThreadList";

export interface HomeListOptions {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly threadVisibility: SidebarThreadVisibility;
}

export interface ResolvedHomeListOptions extends HomeListOptions {
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

export const PROJECT_SORT_OPTIONS: ReadonlyArray<{
  readonly value: HomeProjectSortOrder;
  readonly label: string;
}> = [
  { value: "updated_at", label: "Recent activity" },
  { value: "alphabetical", label: "Alphabetical A-Z" },
  { value: "status", label: "Status" },
  { value: "created_at", label: "Created at" },
];

export const THREAD_SORT_OPTIONS: ReadonlyArray<{
  readonly value: SidebarThreadSortOrder;
  readonly label: string;
}> = [
  { value: "updated_at", label: "Recent activity" },
  { value: "alphabetical", label: "Alphabetical A-Z" },
  { value: "status", label: "Status" },
  { value: "created_at", label: "Created at" },
];

export const THREAD_VISIBILITY_OPTIONS: ReadonlyArray<{
  readonly value: SidebarThreadVisibility;
  readonly label: string;
}> = [
  { value: "active", label: "Active" },
  { value: "recent", label: "Recent" },
  { value: "all", label: "All" },
];

function defaultHomeListOptions(): HomeListOptions {
  return {
    selectedEnvironmentId: null,
    projectSortOrder:
      DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
        ? "updated_at"
        : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
    threadSortOrder: DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
    threadVisibility: DEFAULT_SIDEBAR_THREAD_VISIBILITY,
  };
}

interface HomeListOptionsContextValue {
  readonly options: HomeListOptions;
  readonly setOptions: Dispatch<SetStateAction<HomeListOptions>>;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly persistOptions: (patch: {
    readonly homeProjectSortOrder?: HomeProjectSortOrder;
    readonly homeThreadSortOrder?: SidebarThreadSortOrder;
    readonly homeThreadVisibility?: SidebarThreadVisibility;
  }) => void;
}

const HomeListOptionsContext = createContext<HomeListOptionsContextValue | null>(null);

/** Keeps list preferences stable while the app moves between compact and split shells. */
export function HomeListOptionsProvider({
  children,
  projectGroupingMode,
}: PropsWithChildren<{
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}>) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [options, setOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current || !AsyncResult.isSuccess(preferencesResult)) return;
    hydratedRef.current = true;
    const preferences = preferencesResult.value;
    setOptions((current) => ({
      ...current,
      projectSortOrder: preferences.homeProjectSortOrder ?? current.projectSortOrder,
      threadSortOrder: preferences.homeThreadSortOrder ?? current.threadSortOrder,
      threadVisibility: preferences.homeThreadVisibility ?? current.threadVisibility,
    }));
  }, [preferencesResult]);

  const persistOptions = useCallback(
    (patch: {
      readonly homeProjectSortOrder?: HomeProjectSortOrder;
      readonly homeThreadSortOrder?: SidebarThreadSortOrder;
      readonly homeThreadVisibility?: SidebarThreadVisibility;
    }) => {
      savePreferences(patch);
    },
    [savePreferences],
  );
  const value = useMemo(
    () => ({ options, setOptions, projectGroupingMode, persistOptions }),
    [options, projectGroupingMode, persistOptions],
  );
  return createElement(HomeListOptionsContext, { value }, children);
}

export function hasCustomHomeListOptions(
  options: HomeListOptions & {
    readonly selectedProjectKey?: string | null;
  },
): boolean {
  const defaultProjectSortOrder =
    DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
      ? "updated_at"
      : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER;
  return (
    options.selectedEnvironmentId !== null ||
    (options.selectedProjectKey !== null && options.selectedProjectKey !== undefined) ||
    options.projectSortOrder !== defaultProjectSortOrder ||
    options.threadSortOrder !== DEFAULT_SIDEBAR_THREAD_SORT_ORDER ||
    options.threadVisibility !== DEFAULT_SIDEBAR_THREAD_VISIBILITY
  );
}

export function useHomeListOptions(availableEnvironmentIds: ReadonlySet<EnvironmentId>) {
  const shared = useContext(HomeListOptionsContext);
  const [localOptions, setLocalOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const options = shared?.options ?? localOptions;
  const setOptions = shared?.setOptions ?? setLocalOptions;
  const persistOptions = shared?.persistOptions;
  const selectedEnvironmentId =
    options.selectedEnvironmentId !== null &&
    availableEnvironmentIds.has(options.selectedEnvironmentId)
      ? options.selectedEnvironmentId
      : null;
  const availableOptions =
    selectedEnvironmentId === options.selectedEnvironmentId
      ? options
      : { ...options, selectedEnvironmentId };
  const resolvedOptions: ResolvedHomeListOptions = {
    ...availableOptions,
    projectGroupingMode: shared?.projectGroupingMode ?? "hierarchy",
  };

  const setSelectedEnvironmentId = useCallback((value: EnvironmentId | null) => {
    setOptions((current) => ({ ...current, selectedEnvironmentId: value }));
  }, []);
  const setProjectSortOrder = useCallback(
    (value: HomeProjectSortOrder) => {
      setOptions((current) => ({ ...current, projectSortOrder: value }));
      persistOptions?.({ homeProjectSortOrder: value });
    },
    [persistOptions, setOptions],
  );
  const setThreadSortOrder = useCallback(
    (value: SidebarThreadSortOrder) => {
      setOptions((current) => ({ ...current, threadSortOrder: value }));
      persistOptions?.({ homeThreadSortOrder: value });
    },
    [persistOptions, setOptions],
  );
  const setThreadVisibility = useCallback(
    (value: SidebarThreadVisibility) => {
      setOptions((current) => ({ ...current, threadVisibility: value }));
      persistOptions?.({ homeThreadVisibility: value });
    },
    [persistOptions, setOptions],
  );
  return {
    options: resolvedOptions,
    setSelectedEnvironmentId,
    setProjectSortOrder,
    setThreadSortOrder,
    setThreadVisibility,
  } as const;
}
