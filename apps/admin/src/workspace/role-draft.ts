export type RoleFormFields = {
  name: string;
  description: string;
  status: "ACTIVE" | "DISABLED";
  permissionCodes: string[];
};

export type RoleBaseline = RoleFormFields & { code: string };

export type CreateRoleFields = {
  code: string;
  name: string;
  description: string;
  permissionCodes: string[];
};

export function roleFormDirty(baseline: RoleBaseline | null, form: RoleFormFields): boolean {
  if (!baseline) return false;
  return (
    form.name !== baseline.name ||
    (form.description ?? "") !== (baseline.description ?? "") ||
    form.status !== baseline.status ||
    form.permissionCodes.join(",") !== baseline.permissionCodes.join(",")
  );
}

export function createRoleFormDirty(form: CreateRoleFields): boolean {
  return (
    form.code.trim().length > 0 ||
    form.name.trim().length > 0 ||
    form.description.trim().length > 0 ||
    form.permissionCodes.length > 0
  );
}

export function shouldApplyServerRole(
  baseline: RoleBaseline | null,
  form: RoleFormFields,
  incoming: RoleBaseline,
): boolean {
  if (!baseline || baseline.code !== incoming.code) return true;
  if (!roleFormDirty(baseline, form)) return true;
  return !roleFormDirty(incoming, form);
}

export function rolePageDirty(
  baseline: RoleBaseline | null,
  selectedCode: string | undefined,
  form: RoleFormFields,
  create: CreateRoleFields,
): boolean {
  const editDirty = baseline?.code === selectedCode ? roleFormDirty(baseline, form) : false;
  return editDirty || createRoleFormDirty(create);
}

export function snapshotRole(role: {
  code: string;
  name: string;
  description?: string | null;
  status: "ACTIVE" | "DISABLED";
  permissionCodes: string[];
}): RoleBaseline {
  return {
    code: role.code,
    name: role.name,
    description: role.description ?? "",
    status: role.status,
    permissionCodes: [...role.permissionCodes],
  };
}
