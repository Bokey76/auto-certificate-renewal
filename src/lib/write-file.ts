/** 原子写文件：先写临时文件再改名。 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 先写临时文件再改名，避免读到半截。 */
export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, path);
  } catch {
    rmSync(path, { force: true });
    renameSync(tmp, path);
  }
}
