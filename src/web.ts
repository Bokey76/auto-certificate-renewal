import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isPaused, isRunRequested, readScheduler, requestRun, schedulerOnline, setPaused } from "./control.js";
import { loadOverview } from "./overview.js";
import { loginPage, statusPage } from "./web-page.js";

const BODY_LIMIT = 1024;
const FAIL_LIMIT = 8;
const BLOCK_MS = 60_000;

interface Session {
  csrf: string;
}

export interface WebServer {
  port: number;
  close: () => Promise<void>;
}

export interface WebOptions {
  dataDir: string;
  configPath: string;
  password: string;
  host: string;
  port: number;
  secureCookie: boolean;
  timeZone: string;
  now?: () => Date;
}

/** 在本机提供状态页。调用方负责口令长度；这里只比较和发页面。 */
export function startWeb(options: WebOptions): Promise<WebServer> {
  const now = options.now ?? (() => new Date());
  const sessions = new Map<string, Session>();
  const failures = new Map<string, { count: number; blockedUntil: number }>();
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "读状态失败" });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolve({
        port,
        close: () => new Promise((done, fail) => {
          server.close((error) => (error ? fail(error) : done()));
        }),
      });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    if (method === "POST" && url.pathname === "/login") {
      await login(req, res);
      return;
    }
    const session = findSession(req);
    if (method === "GET" && url.pathname === "/") {
      sendHtml(res, 200, session ? statusPage(session.csrf) : loginPage(null));
      return;
    }
    if (!session) {
      if (method === "POST" || (method === "GET" && url.pathname === "/api/overview")) {
        sendJson(res, 401, { ok: false, error: "未登录" });
        return;
      }
      sendText(res, 404, "没有这个页面");
      return;
    }
    if (!csrfOk(req, session) && method === "POST") {
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
    if (method === "POST" && (url.pathname === "/api/pause" || url.pathname === "/api/resume" || url.pathname === "/api/run")) {
      sendJson(res, 200, perform(url.pathname));
      return;
    }
    sendText(res, 404, "没有这个页面");
  }

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? "unknown";
    const at = now().getTime();
    const blocked = failures.get(ip);
    if (blocked && blocked.blockedUntil > at) {
      sendHtml(res, 429, loginPage("尝试过多，请稍后再试"));
      return;
    }
    const body = await readBody(req);
    if (body === undefined) {
      sendText(res, 413, "请求过大");
      return;
    }
    if (!passwordOk(readPassword(req.headers["content-type"], body), options.password)) {
      const row = failures.get(ip) ?? { count: 0, blockedUntil: 0 };
      row.count += 1;
      if (row.count >= FAIL_LIMIT) {
        row.blockedUntil = at + BLOCK_MS;
        row.count = 0;
      }
      failures.set(ip, row);
      sendHtml(res, 401, loginPage("口令不对"));
      return;
    }
    failures.delete(ip);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { csrf: randomBytes(32).toString("hex") });
    res.writeHead(303, {
      Location: "/",
      "Set-Cookie": cookie(token, options.secureCookie),
      "Cache-Control": "no-store",
    });
    res.end();
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
    if (pathname === "/api/resume") {
      setPaused(options.dataDir, false);
      return { ok: true, message: "已恢复定时检查", paused: false, runPending: isRunRequested(options.dataDir) };
    }
    const requested = requestRun(options.dataDir, current.toISOString());
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
}

function csrfOk(req: IncomingMessage, session: Session): boolean {
  const header = req.headers["x-csrf-token"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  return tokenOk(value, session.csrf);
}

function passwordOk(input: string, expected: string): boolean {
  const left = Buffer.from(input);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

function tokenOk(input: string, expected: string): boolean {
  const left = Buffer.from(input);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function readPassword(contentType: string | undefined, body: string): string {
  if ((contentType ?? "").includes("application/json")) {
    try {
      const parsed = JSON.parse(body) as { password?: unknown };
      return typeof parsed.password === "string" ? parsed.password : "";
    } catch {
      return "";
    }
  }
  return new URLSearchParams(body).get("password") ?? "";
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
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

function sendHtml(res: ServerResponse, status: number, html: string): void {
  send(res, status, "text/html; charset=utf-8", html);
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
