/** 登录页和状态页。动态数据由页面脚本用文本节点填入，不拼进 HTML。 */

const LOGIN = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>证书状态</title>
  <style>
    body { margin: 0; font: 16px/1.5 "Segoe UI", "PingFang SC", sans-serif; background: #f3f5f7; color: #1c2430; }
    main { max-width: 420px; margin: 12vh auto; background: #fff; border: 1px solid #e1e6ec; border-radius: 12px; padding: 24px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { margin: 0 0 16px; color: #5c6b7a; }
    label { display: block; font-weight: 600; margin-bottom: 6px; }
    input { font: inherit; width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #c5d0db; border-radius: 8px; }
    button { font: inherit; margin-top: 16px; background: #1f4e79; color: #fff; border: 0; border-radius: 8px; padding: 8px 14px; cursor: pointer; }
    .bad { color: #9f1239; min-height: 1.5em; }
  </style>
</head>
<body>
  <main>
    <h1>证书状态</h1>
    <p>查看这台机器最近一轮检查。</p>
    <form method="post" action="/login">
      <label for="password">口令</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <div class="bad">%%ERROR%%</div>
      <button type="submit">进入</button>
    </form>
  </main>
</body>
</html>
`;

const STATUS = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="%%CSRF%%">
  <title>证书状态</title>
  <style>
    body { margin: 0; font: 15px/1.5 "Segoe UI", "PingFang SC", sans-serif; background: #f3f5f7; color: #1c2430; }
    main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
    header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
    h1 { font-size: 22px; margin: 0; }
    h2 { font-size: 18px; margin: 0 0 8px; }
    .card { background: #fff; border: 1px solid #e1e6ec; border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; }
    .muted { color: #5c6b7a; }
    .bad { color: #9f1239; }
    .ok { color: #157347; }
    button { font: inherit; border: 1px solid #c5d0db; background: #fff; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
    button.primary { background: #1f4e79; color: #fff; border-color: #1f4e79; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid #e7edf2; }
    th { font-size: 13px; color: #5c6b7a; }
    tr.bad { background: #fff5f5; }
    .pre { white-space: pre-wrap; }
    pre { margin: 0; max-height: 360px; overflow: auto; background: #0f1720; color: #e8eef5; padding: 12px; border-radius: 8px; font: 12px/1.45 ui-monospace, Consolas, monospace; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>证书状态</h1>
      <button type="button" id="logout">退出</button>
    </header>
    <section class="card">
      <h2 id="server-name">…</h2>
      <p id="scheduler"></p>
      <p id="next-run" class="muted"></p>
      <p id="last-run"></p>
      <p id="note" class="muted"></p>
      <p id="config-error" class="bad"></p>
      <div class="actions">
        <button type="button" class="primary" id="run">立即检查</button>
        <button type="button" id="pause">暂停定时检查</button>
        <button type="button" id="resume">恢复定时检查</button>
      </div>
      <p id="action-message"></p>
    </section>
    <section class="card">
      <h2>任务</h2>
      <div class="wrap">
        <table>
          <thead>
            <tr>
              <th>任务</th><th>启用</th><th>域名</th><th>本轮</th><th>到期</th><th>指纹</th><th>钩子</th><th>Nginx</th><th>CDN</th><th>证书服务</th>
            </tr>
          </thead>
          <tbody id="jobs"></tbody>
        </table>
      </div>
    </section>
    <section class="card">
      <h2>最近日志</h2>
      <p id="log-message" class="muted"></p>
      <pre id="log"></pre>
    </section>
  </main>
  <script>
    const csrf = document.querySelector('meta[name="csrf-token"]').content;
    const jobsBody = document.getElementById("jobs");

    function text(id, value) {
      const el = document.getElementById(id);
      el.textContent = value || "";
    }

    function checkLabel(value) {
      if (value === "passed") return "通过";
      if (value === "failed") return "失败";
      return "跳过";
    }

    function nginxText(items) {
      if (!items || items.length === 0) return "无";
      return items.map(function (item) {
        const err = item.error ? " " + item.error : "";
        return item.path + " 测试" + checkLabel(item.nginxTest) + " 重载" + checkLabel(item.nginxReload) + err;
      }).join("\\n");
    }

    function cdnText(items) {
      if (!items || items.length === 0) return "无";
      return items.map(function (item) { return item.domain + " " + item.text; }).join("\\n");
    }

    function cell(tr, value, pre) {
      const td = document.createElement("td");
      td.textContent = value || "";
      if (pre) td.className = "pre";
      tr.appendChild(td);
    }

    function paint(view) {
      const server = view.server;
      text("server-name", server.serverName);
      text("scheduler", server.scheduler.activityText);
      const scheduler = document.getElementById("scheduler");
      scheduler.className = server.scheduler.online ? "ok" : "bad";
      text("next-run", server.scheduler.nextRunText ? "下次检查 " + server.scheduler.nextRunText : "还没有安排下次检查");
      text("last-run", server.lastRun ? "最近一轮 " + (server.lastRun.finishedText || "") + " " + server.lastRun.summaryText : "还没有检查记录");
      const last = document.getElementById("last-run");
      last.className = server.lastRun && server.lastRun.exitCode !== 0 ? "bad" : "";
      text("note", server.scheduler.note);
      text("config-error", server.configError);
      jobsBody.replaceChildren();
      if (!server.jobs.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 10;
        td.textContent = "没有任务";
        tr.appendChild(td);
        jobsBody.appendChild(tr);
      }
      server.jobs.forEach(function (job) {
        const tr = document.createElement("tr");
        if (job.status === "failed" || job.status === "invalid") tr.className = "bad";
        cell(tr, job.id);
        cell(tr, job.enabledText);
        cell(tr, (job.domains || []).join("\\n"), true);
        cell(tr, job.error ? job.statusText + "\\n" + job.error : job.statusText, true);
        cell(tr, [job.notAfterText, job.expiryText].filter(Boolean).join("\\n"), true);
        cell(tr, job.fingerprintPrefix || "无");
        cell(tr, job.hook);
        cell(tr, nginxText(job.nginx), true);
        cell(tr, cdnText(job.cdn), true);
        cell(tr, job.cas ? job.cas.name + " / " + job.cas.certId : "无");
        jobsBody.appendChild(tr);
      });
      text("log-message", view.log.message);
      text("log", (view.log.lines || []).join("\\n"));
    }

    async function refresh() {
      try {
        const res = await fetch("/api/overview");
        if (res.status === 401) {
          text("note", "登录已失效，请刷新页面。");
          return;
        }
        paint(await res.json());
      } catch (err) {
        text("note", "暂时连不上状态接口。");
      }
    }

    async function act(path) {
      try {
        const res = await fetch(path, { method: "POST", headers: { "x-csrf-token": csrf } });
        if (res.status === 401) {
          text("note", "登录已失效，请刷新页面。");
          return;
        }
        const body = await res.json();
        text("action-message", body.message || body.error || "");
        await refresh();
      } catch (err) {
        text("action-message", "操作没有送到。");
      }
    }

    document.getElementById("run").addEventListener("click", function () { act("/api/run"); });
    document.getElementById("pause").addEventListener("click", function () { act("/api/pause"); });
    document.getElementById("resume").addEventListener("click", function () { act("/api/resume"); });
    document.getElementById("logout").addEventListener("click", async function () {
      await fetch("/logout", { method: "POST", headers: { "x-csrf-token": csrf } });
      location.href = "/";
    });
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>
`;

/** 登录页。error 只接受程序自己的固定句子。 */
export function loginPage(error: string | null): string {
  return LOGIN.replace("%%ERROR%%", escapeHtml(error ?? ""));
}

/** 状态页。csrf 是会话里的十六进制令牌。 */
export function statusPage(csrf: string): string {
  if (!/^[a-f0-9]+$/.test(csrf)) throw new Error("csrf");
  return STATUS.replaceAll("%%CSRF%%", csrf);
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
