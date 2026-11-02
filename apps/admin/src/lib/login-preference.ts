export const REMEMBERED_ADMIN_IDENTIFIER_KEY = "zzsh-admin-remembered-identifier-v1";

/** Only an explicitly remembered login identifier belongs here, never credentials or sessions. */
export function readRememberedAdminIdentifier(): string | null {
  try {
    const value = window.localStorage.getItem(REMEMBERED_ADMIN_IDENTIFIER_KEY);
    return value && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  } catch { return null; }
}

export function saveRememberedAdminIdentifier(identifier: string | null): boolean {
  try {
    if (identifier === null) window.localStorage.removeItem(REMEMBERED_ADMIN_IDENTIFIER_KEY);
    else {
      const value = identifier.trim();
      if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) return false;
      window.localStorage.setItem(REMEMBERED_ADMIN_IDENTIFIER_KEY, value);
    }
    return identifier === null ? window.localStorage.getItem(REMEMBERED_ADMIN_IDENTIFIER_KEY) === null
      : window.localStorage.getItem(REMEMBERED_ADMIN_IDENTIFIER_KEY) === identifier.trim();
  } catch { return false; }
}
