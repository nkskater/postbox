/**
 * The group name to workspace role mapping. Groups named after a role carry that role for
 * their members; any other group name is free. Both directions of the mapping are the same
 * table, so they cannot disagree.
 */
export type ScimRole = "owner" | "editor" | "viewer";

export const GROUP_ROLE_MAP: Record<string, ScimRole> = {
  Owners: "owner",
  Editors: "editor",
  Viewers: "viewer",
};

export function roleForGroupName(name: string): ScimRole | null {
  const key = name.trim().toLowerCase();
  for (const [group, role] of Object.entries(GROUP_ROLE_MAP)) if (group.toLowerCase() === key) return role;
  return null;
}

export function groupNameForRole(role: ScimRole): string | null {
  for (const [group, mapped] of Object.entries(GROUP_ROLE_MAP)) if (mapped === role) return group;
  return null;
}
