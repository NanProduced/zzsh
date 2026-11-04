import fs from "node:fs";
import { randomUUID } from "node:crypto";

// A stale staging file must not hide the original write error or block recovery.
export function writeLoadCheckpoint(file, value) {
  const temporary = file + "." + randomUUID() + ".new";
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temporary, file); return; }
    catch (error) {
      if (attempt < 3 && ["EACCES", "EPERM", "EBUSY"].includes(error.code)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
        continue;
      }
      error.checkpointTemporaryFile = temporary;
      throw error;
    }
  }
}
