import { scopedProjectKey, scopeProjectRef } from "@cadsense/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef } from "@cadsense/contracts";
import type { Project } from "./types";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: 1;
  memberProjects: readonly [SidebarProjectGroupMember];
  memberProjectRefs: readonly [ScopedProjectRef];
}

export function derivePhysicalProjectKey(project: Pick<Project, "environmentId" | "id">): string {
  return scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
}

export const getProjectOrderKey = derivePhysicalProjectKey;

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  primaryEnvironmentId: EnvironmentId | null;
}): Map<string, string> {
  return new Map(
    input.projects.map((project) => {
      const key = derivePhysicalProjectKey(project);
      return [key, key] as const;
    }),
  );
}

export function buildSidebarProjectSnapshots(input: {
  projects: ReadonlyArray<Project>;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
}): SidebarProjectSnapshot[] {
  return input.projects.map((project) => {
    const projectKey = derivePhysicalProjectKey(project);
    const member: SidebarProjectGroupMember = {
      ...project,
      physicalProjectKey: projectKey,
      environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
    };
    return {
      ...project,
      projectKey,
      displayName: project.title,
      groupedProjectCount: 1,
      memberProjects: [member],
      memberProjectRefs: [scopeProjectRef(project.environmentId, project.id)],
    };
  });
}
