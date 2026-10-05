import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import {
  buildProjectGroups,
  deriveProjectHierarchyPresentation,
  resolveProjectGroupingMode,
  type ProjectGroupingSettings,
} from "./logicalProject";
import type { Project } from "./types";

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  // True iff every non-primary member of this group lives in a
  // desktopLocal env (today: the WSL backend). The sidebar uses this
  // to differentiate "lives on this machine but in a sandbox" from
  // "lives on a real remote" so the project header can pick a
  // container icon instead of the generic cloud icon.
  allRemoteMembersAreDesktopLocal: boolean;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
  hierarchy: {
    readonly portfolioKey: string;
    readonly portfolioLabel: string;
    readonly repositoryKey: string;
    readonly repositoryLabel: string;
    readonly workspaceLabel: string;
    readonly isMainWorkspace: boolean;
  } | null;
}

export interface SidebarProjectPickerEntry {
  group: SidebarProjectSnapshot;
  targetProject: SidebarProjectGroupMember;
  isPreferred: boolean;
}

export interface SidebarHierarchyRepository {
  readonly key: string;
  readonly label: string;
  readonly projects: readonly SidebarProjectSnapshot[];
}

export interface SidebarHierarchyPortfolio {
  readonly key: string;
  readonly label: string;
  readonly repositories: readonly SidebarHierarchyRepository[];
}

/**
 * Presentation-only hierarchy. Input order is preserved inside each repository,
 * so the user's Recent/Created/Manual workspace sort continues to apply there.
 * Portfolio and repository buckets are alphabetical for predictable navigation.
 */
export function groupSidebarProjectsByHierarchy(
  projects: readonly SidebarProjectSnapshot[],
): readonly SidebarHierarchyPortfolio[] {
  const portfolios = new Map<
    string,
    {
      label: string;
      repositories: Map<string, { label: string; projects: SidebarProjectSnapshot[] }>;
    }
  >();

  for (const project of projects) {
    const hierarchy = project.hierarchy;
    if (!hierarchy) continue;
    let portfolio = portfolios.get(hierarchy.portfolioKey);
    if (!portfolio) {
      portfolio = { label: hierarchy.portfolioLabel, repositories: new Map() };
      portfolios.set(hierarchy.portfolioKey, portfolio);
    }
    let repository = portfolio.repositories.get(hierarchy.repositoryKey);
    if (!repository) {
      repository = { label: hierarchy.repositoryLabel, projects: [] };
      portfolio.repositories.set(hierarchy.repositoryKey, repository);
    }
    repository.projects.push(project);
  }

  return [...portfolios.entries()]
    .sort(([, left], [, right]) => left.label.localeCompare(right.label))
    .map(([portfolioKey, portfolio]) => ({
      key: portfolioKey,
      label: portfolio.label,
      repositories: [...portfolio.repositories.entries()]
        .sort(([, left], [, right]) => left.label.localeCompare(right.label))
        .map(([repositoryKey, repository]) => ({
          key: repositoryKey,
          label: repository.label,
          projects: repository.projects,
        })),
    }));
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): Map<string, string> {
  const mapping = new Map<string, string>();
  const groups = buildProjectGroups({
    projects: input.projects,
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  });
  for (const group of groups) {
    for (const member of group.members) {
      mapping.set(member.physicalProjectKey, group.key);
    }
  }
  return mapping;
}

export function buildSidebarProjectSnapshots(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  // Returns true when an env id maps to a desktopLocal saved-env
  // record (today: the WSL backend). Defaults to "false for every
  // env" so callers that don't care about the distinction get the
  // legacy behavior.
  isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
}): SidebarProjectSnapshot[] {
  return buildProjectGroups({
    projects: input.projects,
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  }).map((group): SidebarProjectSnapshot => {
    const members = group.members.map(
      ({ physicalProjectKey, project }): SidebarProjectGroupMember => ({
        ...project,
        physicalProjectKey,
        environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
      }),
    );
    const representative =
      members.find(
        (member) =>
          member.environmentId === group.representative.environmentId &&
          member.id === group.representative.id,
      ) ?? members[0]!;

    const hasLocal =
      input.primaryEnvironmentId !== null &&
      members.some((member) => member.environmentId === input.primaryEnvironmentId);
    const hasRemote =
      input.primaryEnvironmentId !== null
        ? members.some((member) => member.environmentId !== input.primaryEnvironmentId)
        : false;
    const remoteMembers = members.filter(
      (member) =>
        input.primaryEnvironmentId !== null && member.environmentId !== input.primaryEnvironmentId,
    );
    const remoteEnvironmentLabels = remoteMembers
      .flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : []))
      .filter((label, index, labels) => labels.indexOf(label) === index);
    const isDesktopLocal = input.isDesktopLocalEnvironment ?? (() => false);
    const allRemoteMembersAreDesktopLocal =
      remoteMembers.length > 0 &&
      remoteMembers.every((member) => isDesktopLocal(member.environmentId));
    const groupingMode = resolveProjectGroupingMode(representative, input.settings);
    const hierarchy =
      groupingMode === "hierarchy"
        ? deriveProjectHierarchyPresentation(group.presentationProject)
        : null;

    return {
      ...representative,
      projectKey: group.key,
      displayName: hierarchy?.workspaceLabel ?? group.label,
      groupedProjectCount: members.length,
      environmentPresence:
        hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
      allRemoteMembersAreDesktopLocal,
      memberProjects: members,
      memberProjectRefs: group.memberProjectRefs,
      remoteEnvironmentLabels,
      hierarchy,
    };
  });
}

export function buildSidebarProjectPickerEntries(input: {
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  preferredProjectRef: ScopedProjectRef | null;
}) {
  const preferredProjectRef = input.preferredProjectRef;
  const entries = input.groups.flatMap((group): SidebarProjectPickerEntry[] => {
    const isPreferred = preferredProjectRef
      ? group.memberProjectRefs.some(
          (projectRef) =>
            projectRef.environmentId === preferredProjectRef.environmentId &&
            projectRef.projectId === preferredProjectRef.projectId,
        )
      : false;
    const preferredProject = preferredProjectRef
      ? (group.memberProjects.find(
          (project) =>
            project.environmentId === preferredProjectRef.environmentId &&
            project.id === preferredProjectRef.projectId,
        ) ??
        group.memberProjects.find(
          (project) => project.environmentId === preferredProjectRef.environmentId,
        ))
      : null;
    const targetProject =
      preferredProject ??
      group.memberProjects.find(
        (project) => project.environmentId === group.environmentId && project.id === group.id,
      ) ??
      group.memberProjects[0];
    if (!targetProject) return [];

    return [{ group, targetProject, isPreferred }];
  });
  const preferredIndex = entries.findIndex((entry) => entry.isPreferred);
  if (preferredIndex <= 0) return entries;

  return [
    entries[preferredIndex]!,
    ...entries.slice(0, preferredIndex),
    ...entries.slice(preferredIndex + 1),
  ];
}
