/**
 * POSIX permission bits deny access only to non-root users on non-Windows
 * platforms. Root bypasses `chmod`-based denial, so permission-failure
 * tests skip when this flag reads false.
 */
export const canEnforcePermissions =
  process.platform !== "win32" && process.getuid?.() !== 0;
