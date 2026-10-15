export type SupplyWriteLockCode = "LOCK_BUSY" | "LOCK_UNAVAILABLE";

export class SupplyWriteLockError extends Error {
  readonly code: SupplyWriteLockCode;

  constructor(code: SupplyWriteLockCode) {
    super(code === "LOCK_BUSY"
      ? "另一窗口正在处理本管理员的供给提交，请先核对原窗口，不要重复提交。"
      : "当前浏览器无法提供跨窗口写入锁，操作未发送；请检查浏览器支持与权限。");
    this.name = "SupplyWriteLockError";
    this.code = code;
  }
}

// 调用方在锁内重读恢复记录，并覆盖保存、原命令处理及匹配 key 的清理；锁不替代服务端授权与 CAS。
export async function withSupplyWriteLock<T>(storageKey: string, task: () => Promise<T>): Promise<T> {
  let locks: LockManager | undefined;
  try { locks = typeof navigator === "undefined" ? undefined : navigator.locks; }
  catch { throw new SupplyWriteLockError("LOCK_UNAVAILABLE"); }
  if (!locks || typeof locks.request !== "function") throw new SupplyWriteLockError("LOCK_UNAVAILABLE");

  let started = false;
  try {
    return await locks.request(`zzsh:supply-write:${storageKey}`, { mode: "exclusive", ifAvailable: true }, async lock => {
      if (!lock) throw new SupplyWriteLockError("LOCK_BUSY");
      started = true;
      return await task();
    });
  } catch (failure) {
    if (started || failure instanceof SupplyWriteLockError) throw failure;
    throw new SupplyWriteLockError("LOCK_UNAVAILABLE");
  }
}
