/** 配置旁的 admins.json。口令 scrypt 哈希；不能删自己或最后一个。 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { atomicWrite } from "../lib/write-file.js";

const USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38}[A-Za-z0-9])?$/;
const KEYLEN = 32;
const SCRYPT: ScryptOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface AdminPublic {
  username: string;
  createdAt: string;
}

interface AdminUser extends AdminPublic {
  passwordHash: string;
}

interface AdminFile {
  users: AdminUser[];
}

/** 管理员文件在配置 YAML 同目录。 */
export function adminsPath(configPath: string): string {
  return join(dirname(configPath), "admins.json");
}

/** 没有用户时打开网页走初始化。 */
export function hasAdmins(path: string): boolean {
  return readUsers(path).length > 0;
}

/** 列表不含口令哈希。 */
export function listAdmins(path: string): AdminPublic[] {
  return readUsers(path).map((user) => ({ username: user.username, createdAt: user.createdAt }));
}

/** 用户不存在时仍做一次哈希，避免按耗时判断账号是否在。 */
export async function verifyAdmin(path: string, username: string, password: string): Promise<boolean> {
  const user = readUsers(path).find((item) => item.username === username);
  if (!user) {
    await hashPassword(password);
    return false;
  }
  return verifyPassword(password, user.passwordHash);
}

/** 只在空文件时创建第一个管理员。 */
export async function createFirstAdmin(
  path: string,
  username: string,
  password: string,
  at: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (hasAdmins(path)) return { ok: false, error: "已经有管理员" };
  const checked = checkAccount(username, password);
  if (checked) return { ok: false, error: checked };
  const user: AdminUser = { username, passwordHash: await hashPassword(password), createdAt: at };
  writeUsers(path, [user]);
  return { ok: true };
}

/** 已登录管理员再加人。用户名已存在则失败。 */
export async function addAdmin(
  path: string,
  username: string,
  password: string,
  at: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const checked = checkAccount(username, password);
  if (checked) return { ok: false, error: checked };
  const users = readUsers(path);
  if (users.some((item) => item.username === username)) return { ok: false, error: "用户名已存在" };
  users.push({ username, passwordHash: await hashPassword(password), createdAt: at });
  writeUsers(path, users);
  return { ok: true };
}

/** 不能删自己，也不能删最后一个。 */
export function removeAdmin(path: string, username: string, actor: string): { ok: true } | { ok: false; error: string } {
  const users = readUsers(path);
  if (username === actor) return { ok: false, error: "不能删除自己" };
  if (users.length <= 1) return { ok: false, error: "不能删除最后一个管理员" };
  const next = users.filter((item) => item.username !== username);
  if (next.length === users.length) return { ok: false, error: "没有这个管理员" };
  writeUsers(path, next);
  return { ok: true };
}

/** 改自己的口令。新口令同样至少 12 位。 */
export async function changePassword(
  path: string,
  username: string,
  current: string,
  next: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (next.length < 12) return { ok: false, error: "口令至少要有 12 位" };
  const users = readUsers(path);
  const user = users.find((item) => item.username === username);
  if (!user) return { ok: false, error: "没有这个管理员" };
  if (!(await verifyPassword(current, user.passwordHash))) return { ok: false, error: "当前口令不对" };
  user.passwordHash = await hashPassword(next);
  writeUsers(path, users);
  return { ok: true };
}

function checkAccount(username: string, password: string): string | null {
  if (!USERNAME.test(username)) return "用户名必须是 1–40 位字母、数字、下划线或连字符，且不能以下划线或连字符开头或结尾";
  if (password.length < 12) return "口令至少要有 12 位";
  return null;
}

function readUsers(path: string): AdminUser[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AdminFile>;
    if (!Array.isArray(parsed.users)) return [];
    return parsed.users.filter((item): item is AdminUser => {
      return Boolean(
        item &&
          typeof item.username === "string" &&
          typeof item.passwordHash === "string" &&
          typeof item.createdAt === "string",
      );
    });
  } catch {
    return [];
  }
}

function writeUsers(path: string, users: AdminUser[]): void {
  atomicWrite(path, `${JSON.stringify({ users }, null, 2)}\n`);
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptHash(password, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4], "hex");
  const expected = Buffer.from(parts[5], "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await scryptHash(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function scryptHash(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}
