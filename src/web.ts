import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import {
  addAdmin,
  adminsPath,
  changePassword,
  createFirstAdmin,
  hasAdmins,
  listAdmins,
  removeAdmin,
  verifyAdmin,
} from "./admins.js";
import { configDocument, loadConfig, readConfigText, saveConfigObject, saveConfigText } from "./config.js";
import { isPaused, isRunRequested, readScheduler, requestRun, schedulerOnline, setPaused } from "./control.js";
import { deleteCredential, listCredentialViews, upsertCredential } from "./credentials.js";
import { loadOverview } from "./overview.js";

const LOGIN_BODY_LIMIT = 1024;
const BODY_LIMIT = 256 * 1024;
const FAIL_LIMIT = 8;
const BLOCK_MS = 60_000;

const STATIC: Record<string, string> = {
  "/app.css": "text/css; charset=utf-8",
  "/setup.js": "text/javascript; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
};

interface Session {
  csrf: string;
  username: string;
}

export interface WebServer {
  port: number;
  close: () => Promise<void>;
}

export interface WebOptions {
  dataDir: string;
  configPath: string;
  webDir: string;
  host: string;
  port: number;
  secureCookie: boolean;
  timeZone: string;
  now?: () => Date;
}

/** 在本机提供控制台。调用方负责端口；这里发页面、管会话和写配置。 */
export function startWeb(options: WebOptions): Promise<WebServer> {
  const now = options.now ?? (() => new Date());
  const sessions = new Map<string, Session>();
  const failures = new Map<string, { count: number; blockedUntil: number }>();
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "处理失败" });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({
        port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    if (method === "GET" && STATIC[url.pathname]) {
      sendStatic(res, url.pathname, STATIC[url.pathname]);
      return;
    }
    if (method === "POST" && url.pathname === "/api/setup") {
      await setup(req, res);
      return;
    }
    if (method === "POST" && url.pathname === "/login") {
      await login(req, res);
      return;
    }
    const session = findSession(req);
    if (method === "GET" && url.pathname === "/") {
      if (!hasAdmins(adminsPath(options.configPath))) {
        sendHtmlFile(res, "setup.html");
        return;
      }
      if (!session) {
        sendHtmlFile(res, "login.html");
        return;
      }
      sendHtmlFile(res, "app.html", session.csrf);
      return;
    }
    if (!session) {
      if (method !== "GET" || url.pathname.startsWith("/api/")) {
        sendJson(res, 401, { ok: false, error: "未登录" });
        return;
      }
      sendText(res, 404, "没有这个页面");
      return;
    }
    if (method !== "GET" && !csrfOk(req, session)) {
      sendJson(res, 403, { ok: false, error: "缺少校验" });
      return;
    }
    if (method === "POST" && url.pathname === "/logout") {
      const token = readCookie(req, "acme_web");
      if (token) sessions.delete(token);
      res.writeHead(303, { Location: "/", "Set-Cookie": clearCookie(options.secureCookie), "Cache-Control": "no-store" });
      res.end();
      return;
    }
    if (method === "GET" && url.pathname === "/api/overview") {
      sendJson(res, 200, loadOverview({
        dataDir: options.dataDir,
        configPath: options.configPath,
        now: now(),
        timeZone: options.timeZone,
      }));
      return;
    }
    if (method === "GET" && url.pathname === "/api/config/raw") {
      sendJson(res, 200, { ok: true, text: readConfigText(options.configPath) ?? "" });
      return;
    }
    if (method === "GET" && url.pathname === "/api/config") {
      sendJson(res, 200, configPayload());
      return;
    }
    if (method === "PUT" && url.pathname === "/api/config/raw") {
      const body = await readBody(req, BODY_LIMIT);
      if (body === undefined) {
        sendJson(res, 413, { ok: false, error: "请求过大" });
        return;
      }
      const parsed = parseJson(body) as { text?: unknown };
      if (typeof parsed.text !== "string") {
        sendJson(res, 400, { ok: false, error: "需要 YAML 文本" });
        return;
      }
      const saved = saveConfigText(options.configPath, parsed.text);
      sendJson(res, saved.ok ? 200 : 400, saved);
      return;
    }
    if (method === "PUT" && url.pathname === "/api/config") {
      const body = await readBody(req, BODY_LIMIT);
      if (body === undefined) {
        sendJson(res, 413, { ok: false, error: "请求过大" });
        return;
      }
      const saved = saveConfigObject(options.configPath, parseJson(body));
      sendJson(res, saved.ok ? 200 : 400, saved);
      return;
    }
    if (method === "GET" && url.pathname === "/api/credentials") {
      sendJson(res, 200, { ok: true, credentials: listCredentialViews(options.configPath) });
      return;
    }
    if (method === "PUT" && url.pathname === "/api/credentials") {
      const body = await readBody(req, LOGIN_BODY_LIMIT);
      if (body === undefined) {
        sendJson(res, 413, { ok: false, error: "请求过大" });
        return;
      }
      const parsed = parseJson(body) as { name?: unknown; accessKeyId?: unknown; accessKeySecret?: unknown };
      const saved = upsertCredential(
        options.configPath,
        typeof parsed.name === "string" ? parsed.name : "",
        typeof parsed.accessKeyId === "string" ? parsed.accessKeyId : "",
        typeof parsed.accessKeySecret === "string" ? parsed.accessKeySecret : "",
      );
      sendJson(res, saved.ok ? 200 : 400, saved);
      return;
    }
    if (method === "DELETE" && url.pathname === "/api/credentials") {
      const body = await readBody(req, LOGIN_BODY_LIMIT);
      if (body === undefined) {
        sendJson(res, 413, { ok: false, error: "请求过大" });
        return;
      }
      const parsed = parseJson(body) as { name?: unknown };
      const saved = deleteCredential(options.configPath, typeof parsed.name === "string" ? parsed.name : "");
      sendJson(res, saved.ok ? 200 : 400, saved);
      return;
    }
    if (method === "GET" && url.pathname === "/api/admins") {
      sendJson(res, 200, { ok: true, me: session.username, users: listAdmins(adminsPath(options.configPath)) });
      return;
    }
    if (method === "POST" && url.pathname === "/api/admins") {
      const body = await readBody(req, LOGIN_BODY_LIMIT);
      if (body === undefined) {
        sendJson(res, 413, { ok: false, error: "请求过大" });
        return;
      }
      const parsed = parseJson(body) as { username?: unknown; password?: unknown };
      const saved = await addAdmin(
        adminsPath(options.configPath),
        typeof parsed.username === "string" ? parsed.username : "",
        typeof parsed.password === "string" ? parsed.password : "",
        now().toISOString(),
      );
      sendJson(res, saved.ok ? 200 : 400, saved);
      return;
    }
    if (method === "DELETE" && url.pathname === "/api/admins") {
      const body = await readBody(req, LOGIN_BODY_LIMIT);
      if (body === undefined) {
        sendJson(res, 413, { ok: false, error: "请求过大" });
        return;
      }
      const parsed = parseJson(body) as { username?: unknown };
      const saved = removeAdmin(
        adminsPath(options.configPath),
        typeof parsed.username === "string" ? parsed.username : "",
        session.username,
      );
      sendJson(res, saved.ok ? 200 : 400, saved);
      return;
    }
    if (method === "POST" && url.pathname === "/api/admins/password") {
      const body = await readBody(req, LOGIN_BODY_LIMIT);
      if (body === undefined) {
        sendJson(res, 413, { ok: false, error: "请求过大" });
        return;
      }
      const parsed = parseJson(body) as { currentPassword?: unknown; newPassword?: unknown };
      const saved = await changePassword(
        adminsPath(options.configPath),
        session.username,
        typeof parsed.currentPassword === "string" ? parsed.currentPassword : "",
        typeof parsed.newPassword === "string" ? parsed.newPassword : "",
      );
      sendJson(res, saved.ok ? 200 : 400, saved);
      return;
    }
    if (method === "POST" && (url.pathname === "/api/pause" || url.pathname === "/api/resume" || url.pathname === "/api/run")) {
      if (url.pathname === "/api/run") {
        const body = await readBody(req, LOGIN_BODY_LIMIT);
        if (body === undefined) {
          sendJson(res, 413, { ok: false, error: "请求过大" });
          return;
        }
        const parsed = body.trim() ? parseJson(body) : {};
        sendJson(res, 200, performRun(parsed));
        return;
      }
      sendJson(res, 200, perform(url.pathname));
      return;
    }
    sendText(res, 404, "没有这个页面");
  }

  function configPayload(): { ok: true; config: Record<string, unknown>; invalidJobs: unknown[] } | { ok: false; error: string } {
    const loaded = loadConfig(options.configPath);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    return { ok: true, config: configDocument(loaded.config), invalidJobs: loaded.invalidJobs };
  }

  async function setup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (blocked(req, res, "setup")) return;
    const body = await readBody(req, LOGIN_BODY_LIMIT);
    if (body === undefined) {
      sendJson(res, 413, { ok: false, error: "请求过大" });
      return;
    }
    const parsed = parseJson(body) as { username?: unknown; password?: unknown };
    const username = typeof parsed.username === "string" ? parsed.username.trim() : "";
    const password = typeof parsed.password === "string" ? parsed.password : "";
    const created = await createFirstAdmin(adminsPath(options.configPath), username, password, now().toISOString());
    if (!created.ok) {
      noteFailure(req);
      sendJson(res, 400, created);
      return;
    }
    clearFailure(req);
    beginSession(res, username);
  }

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (blocked(req, res, "login")) return;
    const body = await readBody(req, LOGIN_BODY_LIMIT);
    if (body === undefined) {
      sendText(res, 413, "请求过大");
      return;
    }
    const fields = readLogin(req.headers["content-type"], body);
    if (!(await verifyAdmin(adminsPath(options.configPath), fields.username, fields.password))) {
      noteFailure(req);
      sendHtmlFile(res, "login.html", undefined, 401, "用户名或口令不对");
      return;
    }
    clearFailure(req);
    beginSession(res, fields.username);
  }

  function beginSession(res: ServerResponse, username: string): void {
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { csrf: randomBytes(32).toString("hex"), username });
    res.writeHead(303, {
      Location: "/",
      "Set-Cookie": cookie(token, options.secureCookie),
      "Cache-Control": "no-store",
    });
    res.end();
  }

  function blocked(req: IncomingMessage, res: ServerResponse, kind: "login" | "setup"): boolean {
    const ip = req.socket.remoteAddress ?? "unknown";
    const at = now().getTime();
    const row = failures.get(ip);
    if (row && row.blockedUntil > at) {
      if (kind === "login") sendHtmlFile(res, "login.html", undefined, 429, "尝试过多，请稍后再试");
      else sendJson(res, 429, { ok: false, error: "尝试过多，请稍后再试" });
      return true;
    }
    return false;
  }

  function noteFailure(req: IncomingMessage): void {
    const ip = req.socket.remoteAddress ?? "unknown";
    const at = now().getTime();
    const row = failures.get(ip) ?? { count: 0, blockedUntil: 0 };
    row.count += 1;
    if (row.count >= FAIL_LIMIT) {
      row.blockedUntil = at + BLOCK_MS;
      row.count = 0;
    }
    failures.set(ip, row);
  }

  function clearFailure(req: IncomingMessage): void {
    failures.delete(req.socket.remoteAddress ?? "unknown");
  }

  function perform(pathname: string): { ok: true; message: string; paused: boolean; runPending: boolean } {
    const current = now();
    const snapshot = readScheduler(options.dataDir);
    const online = schedulerOnline(snapshot, current);
    const running = online && snapshot?.state === "running";
    if (pathname === "/api/pause") {
      setPaused(options.dataDir, true);
      return {
        ok: true,
        message: running ? "暂停已记下，当前这轮会跑完" : "已暂停定时检查",
        paused: true,
        runPending: isRunRequested(options.dataDir),
      };
    }
    setPaused(options.dataDir, false);
    return { ok: true, message: "已恢复定时检查", paused: false, runPending: isRunRequested(options.dataDir) };
  }

  function performRun(body: unknown): { ok: true; message: string; paused: boolean; runPending: boolean } | { ok: false; error: string } {
    const parsed = isRecord(body) ? body : {};
    const jobId = parsed.jobId === undefined || parsed.jobId === null || parsed.jobId === "" ? null : parsed.jobId;
    if (jobId !== null && typeof jobId !== "string") return { ok: false, error: "任务 id 不合法" };
    const current = now();
    const requested = requestRun(options.dataDir, {
      at: current.toISOString(),
      jobId,
      dryRun: parsed.dryRun === true,
      force: parsed.force === true,
    });
    const snapshot = readScheduler(options.dataDir);
    const online = schedulerOnline(snapshot, current);
    const running = online && snapshot?.state === "running";
    const message = requested.already
      ? "已经记下"
      : !online
        ? "已请求。调度进程起来后才会执行"
        : running
          ? "已记下，这一轮结束后再跑一轮"
          : "已请求，等待调度开始";
    return { ok: true, message, paused: isPaused(options.dataDir), runPending: true };
  }

  function findSession(req: IncomingMessage): Session | undefined {
    const token = readCookie(req, "acme_web");
    if (!token) return undefined;
    return sessions.get(token);
  }

  function sendHtmlFile(res: ServerResponse, name: string, csrf?: string, status = 200, error?: string): void {
    const html = readWebFile(name);
    if (html === undefined) {
      sendText(res, 500, "页面文件不在");
      return;
    }
    let body = html;
    if (csrf) body = body.replaceAll("%%CSRF%%", csrf);
    body = body.replaceAll("%%ERROR%%", escapeHtml(error ?? ""));
    send(res, status, "text/html; charset=utf-8", body);
  }

  function sendStatic(res: ServerResponse, pathname: string, type: string): void {
    const html = readWebFile(pathname.slice(1));
    if (html === undefined) {
      sendText(res, 404, "没有这个文件");
      return;
    }
    send(res, 200, type, html);
  }

  function readWebFile(name: string): string | undefined {
    if (name.includes("..") || name.includes(sep) || name.includes("/") || name.includes("\\")) return undefined;
    const path = join(options.webDir, name);
    const normalized = normalize(path);
    if (!normalized.startsWith(normalize(options.webDir))) return undefined;
    if (!existsSync(path) || extname(path) === "") return undefined;
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }
}

function csrfOk(req: IncomingMessage, session: Session): boolean {
  const header = req.headers["x-csrf-token"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  return tokenOk(value, session.csrf);
}

function tokenOk(input: string, expected: string): boolean {
  const left = Buffer.from(input);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function readLogin(contentType: string | undefined, body: string): { username: string; password: string } {
  if ((contentType ?? "").includes("application/json")) {
    const parsed = parseJson(body) as { username?: unknown; password?: unknown };
    return {
      username: typeof parsed.username === "string" ? parsed.username.trim() : "",
      password: typeof parsed.password === "string" ? parsed.password : "",
    };
  }
  const params = new URLSearchParams(body);
  return { username: (params.get("username") ?? "").trim(), password: params.get("password") ?? "" };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return {};
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(undefined);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function cookie(token: string, secure: boolean): string {
  const parts = [`acme_web=${token}`, "HttpOnly", "SameSite=Lax", "Path=/"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(secure: boolean): string {
  const parts = ["acme_web=", "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

function sendText(res: ServerResponse, status: number, text: string): void {
  send(res, status, "text/plain; charset=utf-8", text);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
