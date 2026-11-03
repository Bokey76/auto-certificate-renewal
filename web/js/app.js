/**
 * 控制台前端。
 * 写操作带页面 meta 里的 CSRF；状态和日志用 textContent，不当 HTML。
 * 标签切到任务 / YAML / 凭据 / 管理员时才拉对应接口。
 */
const csrf = document.querySelector('meta[name="csrf-token"]').getAttribute("content");

let dialogMode = null;
let dialogAdminMe = "";
let followCurrent = true;
let selectedLog = "";
let lastOverview = null;
let logCache = { name: "", text: "", tail: 0, hasMore: false };
const LOG_PAGE = 200;
const LOG_MORE = 500;
let logWantedLines = LOG_PAGE;
let logHasMore = false;

function text(id, value) {
  document.getElementById(id).textContent = value || "";
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function iconButton(label, name, className) {
  const button = document.createElement("button");
  button.type = "button";
  if (className) button.className = className;
  button.append(icon(name), document.createTextNode(label));
  return button;
}

async function api(path, options) {
  const headers = { "x-csrf-token": csrf, ...(options && options.headers) };
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    text("action-message", "登录已失效，请刷新页面。");
    throw new Error("unauthorized");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error || body.message || "请求失败");
    error.body = body;
    throw error;
  }
  return body;
}

document.querySelectorAll("nav button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    document.getElementById(button.getAttribute("data-tab")).classList.add("active");
    if (button.getAttribute("data-tab") === "jobs") loadJobs();
    if (button.getAttribute("data-tab") === "yaml") loadYaml();
    if (button.getAttribute("data-tab") === "credentials") loadCredentials();
    if (button.getAttribute("data-tab") === "admins") loadAdmins();
  });
});

function currentLogName(view) {
  return (view.logs && view.logs.current) || "";
}

function fillLogSelect(view) {
  const select = document.getElementById("log-file");
  const files = (view.logs && view.logs.files) || [];
  const current = currentLogName(view);
  if (followCurrent) {
    if (selectedLog && selectedLog !== current) resetLogWindow();
    selectedLog = current;
  } else if (selectedLog && !files.some((file) => file.name === selectedLog)) {
    followCurrent = true;
    resetLogWindow();
    selectedLog = current;
  }
  select.replaceChildren();
  if (files.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "还没有日志";
    select.appendChild(opt);
    select.disabled = true;
    selectedLog = "";
    resetLogWindow();
    return;
  }
  select.disabled = false;
  for (const file of files) {
    const opt = document.createElement("option");
    opt.value = file.name;
    opt.textContent = file.current ? `${file.label}（本轮）` : file.label;
    select.appendChild(opt);
  }
  select.value = selectedLog || files[0].name;
  selectedLog = select.value;
}

function resetLogWindow() {
  logWantedLines = LOG_PAGE;
  logHasMore = false;
  logCache = { name: "", text: "", tail: 0, hasMore: false };
}

function syncLogButtons() {
  document.getElementById("log-more").disabled = !selectedLog || !logHasMore;
  document.getElementById("log-download").disabled = !selectedLog;
}

function applyLogBody(body) {
  const log = document.getElementById("log");
  const text = (body.lines && body.lines.join("\n")) || body.message || "还没有日志";
  logHasMore = Boolean(body.hasMore);
  const fromBottom = log.scrollHeight - log.scrollTop;
  log.textContent = text;
  log.scrollTop = Math.max(0, log.scrollHeight - fromBottom);
  syncLogButtons();
}

async function renderLog(view) {
  fillLogSelect(view);
  const log = document.getElementById("log");
  const name = selectedLog;
  const current = currentLogName(view);
  if (!name) {
    log.textContent = "还没有日志";
    logHasMore = false;
    syncLogButtons();
    return;
  }
  const follow = name === current;
  if (follow && logWantedLines === LOG_PAGE && view.log) {
    applyLogBody(view.log);
    return;
  }
  if (!follow && logCache.name === name && logCache.tail === logWantedLines) {
    log.textContent = logCache.text;
    logHasMore = logCache.hasMore;
    syncLogButtons();
    return;
  }
  try {
    const body = await api(`/api/logs?name=${encodeURIComponent(name)}&tail=${logWantedLines}`);
    if (selectedLog !== name) return;
    logCache = {
      name,
      text: (body.lines && body.lines.join("\n")) || body.message || "",
      tail: logWantedLines,
      hasMore: Boolean(body.hasMore),
    };
    applyLogBody(body);
  } catch (err) {
    if (selectedLog !== name) return;
    if (err.message !== "unauthorized") log.textContent = "日志没有读到。";
    syncLogButtons();
  }
}

async function refresh() {
  try {
    const view = await api("/api/overview");
    lastOverview = view;
    const server = view.server;
    text("server-name", server.serverName);
    const next = server.scheduler.nextRunText ? `下次检查 ${server.scheduler.nextRunText}。` : "";
    const pending = server.scheduler.runRequest
      ? `待执行：${server.scheduler.runRequest.jobId || "全部"}${server.scheduler.runRequest.dryRun ? "（演练）" : ""}${server.scheduler.runRequest.force ? "（强制）" : ""}。`
      : "";
    text("scheduler", `${server.scheduler.activityText}。${next}${server.scheduler.note || ""}${pending}`);
    text("last-run", server.lastRun ? `${server.lastRun.finishedText} ${server.lastRun.summaryText}` : "还没有跑过。");
    text("config-error", server.configError || "");
    const tbody = document.getElementById("jobs-table");
    tbody.replaceChildren();
    for (const job of server.jobs) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = `${job.id} ${job.domains.join(", ")}`;
      const status = document.createElement("td");
      status.textContent = job.statusText;
      const expiry = document.createElement("td");
      expiry.textContent = job.expiryText || job.notAfterText || "";
      const apply = document.createElement("td");
      const parts = [];
      for (const item of job.nginx) parts.push(`Nginx ${item.nginxTest}/${item.nginxReload}`);
      for (const item of job.cdn) parts.push(`${item.domain} ${item.text}`);
      apply.textContent = parts.join("；");
      const actions = document.createElement("td");
      actions.className = "row-actions";
      const runOne = iconButton("跑这一条", "play");
      runOne.addEventListener("click", () => act("/api/run", { jobId: job.id }));
      actions.appendChild(runOne);
      tr.append(name, status, expiry, apply, actions);
      tbody.appendChild(tr);
    }
    await renderLog(view);
  } catch (err) {
    if (err.message !== "unauthorized") text("action-message", "状态没有刷新。");
  }
}

document.getElementById("log-file").addEventListener("change", () => {
  const select = document.getElementById("log-file");
  selectedLog = select.value;
  const current = lastOverview ? currentLogName(lastOverview) : "";
  followCurrent = !selectedLog || selectedLog === current;
  resetLogWindow();
  text("log-message", "");
  if (lastOverview) void renderLog(lastOverview);
});

document.getElementById("log-more").addEventListener("click", () => {
  if (!selectedLog || !logHasMore) return;
  logWantedLines += LOG_MORE;
  logCache = { name: "", text: "", tail: 0, hasMore: false };
  if (lastOverview) void renderLog(lastOverview);
});

document.getElementById("log-download").addEventListener("click", async () => {
  if (!selectedLog) return;
  text("log-message", "");
  try {
    const res = await fetch(`/api/logs?name=${encodeURIComponent(selectedLog)}&download=1`, {
      headers: { "x-csrf-token": csrf },
    });
    if (res.status === 401) {
      text("log-message", "登录已失效，请刷新页面。");
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      text("log-message", body.error || "日志没有下载到。");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = selectedLog;
    link.click();
    URL.revokeObjectURL(url);
  } catch {
    text("log-message", "日志没有下载到。");
  }
});

async function act(path, body) {
  try {
    const payload = path === "/api/run"
      ? {
          jobId: body && body.jobId,
          dryRun: document.getElementById("dry-run").checked,
          force: document.getElementById("force").checked,
        }
      : undefined;
    const result = await api(path, {
      method: "POST",
      headers: payload ? { "content-type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    text("action-message", result.message || result.error || "");
    await refresh();
  } catch (err) {
    text("action-message", err.message || "操作没有送到。");
  }
}

document.getElementById("run").addEventListener("click", () => act("/api/run"));
document.getElementById("pause").addEventListener("click", () => act("/api/pause"));
document.getElementById("resume").addEventListener("click", () => act("/api/resume"));
document.getElementById("logout").addEventListener("click", async () => {
  await fetch("/logout", { method: "POST", headers: { "x-csrf-token": csrf } });
  location.href = "/";
});

function emptyJob() {
  return {
    id: "",
    enabled: true,
    domains: [],
    challenge: { type: "dns-01", zone: "", propagationSeconds: 60 },
    apply: [],
  };
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([key, value]) => {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else if (value !== undefined) node.setAttribute(key, value);
  });
  for (const child of children || []) node.appendChild(child);
  return node;
}

function field(labelText, control, hint) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const lab = document.createElement("label");
  lab.textContent = labelText;
  wrap.append(lab);
  if (hint) wrap.append(el("p", { class: "field-hint", text: hint }));
  wrap.append(control);
  return wrap;
}

function jobTitle(id, domains) {
  const name = (id || "").trim() || "新任务";
  const list = (domains || "").trim();
  return list ? `${name} · ${list}` : name;
}

function toggleAccordion(item) {
  const group = item.parentElement;
  const exclusive = group && group.getAttribute("data-accordion") === "exclusive";
  const wasOpen = item.classList.contains("open");
  if (exclusive) {
    for (const node of group.children) {
      if (node.classList && node.classList.contains("accordion")) node.classList.remove("open");
    }
    if (!wasOpen) item.classList.add("open");
  } else {
    item.classList.toggle("open");
  }
}

function makeAccordion(titleNode, extras, bodyNodes) {
  const head = el("button", { type: "button", class: "accordion-head" });
  const chevron = icon("chevron");
  chevron.classList.add("chevron");
  head.append(chevron, titleNode);
  const bar = el("div", { class: "accordion-bar" }, extras ? [head, ...extras] : [head]);
  const body = el("div", { class: "accordion-body" }, bodyNodes);
  const item = el("div", { class: "accordion" }, [bar, body]);
  head.addEventListener("click", () => toggleAccordion(item));
  item._title = titleNode;
  return item;
}

document.querySelectorAll("[data-accordion-toggle]").forEach((button) => {
  button.addEventListener("click", () => toggleAccordion(button.closest(".accordion")));
});

function retitleApplies(list) {
  let nginx = 0;
  let cdn = 0;
  for (const card of list.children) {
    const summary = card._summary ? card._summary() : "";
    if (card.dataset.type === "nginx") {
      nginx += 1;
      card._title.textContent = summary ? `Nginx ${nginx} · ${summary}` : `Nginx ${nginx}`;
    } else {
      cdn += 1;
      card._title.textContent = summary ? `CDN ${cdn} · ${summary}` : `CDN ${cdn}`;
    }
  }
}

function nginxCard(action, onChange) {
  const kind = el("select", {}, [
    el("option", { value: "baota", text: "宝塔" }),
    el("option", { value: "custom", text: "自装" }),
  ]);
  kind.value = action.kind || "baota";
  const certDir = el("input", { value: action.certDir || "" });
  const fullchainName = el("input", { value: action.fullchainName || "fullchain.pem" });
  const privkeyName = el("input", { value: action.privkeyName || "privkey.pem" });
  const fullchain = el("input", { value: action.fullchainPath || "" });
  const privkey = el("input", { value: action.privkeyPath || "" });
  const bin = el("input", { value: action.nginxBin || "" });
  const baotaDir = field("certDir", certDir, "宝塔证书目录，例如 /www/server/panel/vhost/cert/example.com。不存在时会建出来。");
  const baotaFull = field("fullchainName", fullchainName, "目录里的证书文件名，默认 fullchain.pem。");
  const baotaKey = field("privkeyName", privkeyName, "目录里的私钥文件名，默认 privkey.pem。");
  const customFull = field("fullchainPath", fullchain, "自装 Nginx 的证书完整路径。站点配置须事先指向这里。");
  const customKey = field("privkeyPath", privkey, "自装 Nginx 的私钥完整路径。");
  const title = el("span", { class: "accordion-title", text: "Nginx" });

  function syncKind() {
    const baotaMode = kind.value === "baota";
    baotaDir.hidden = !baotaMode;
    baotaFull.hidden = !baotaMode;
    baotaKey.hidden = !baotaMode;
    customFull.hidden = baotaMode;
    customKey.hidden = baotaMode;
    onChange();
  }

  const remove = iconButton("删除", "trash", "ghost");
  const item = makeAccordion(title, [remove], [
    field("类型", kind, "宝塔只替换证书目录里的文件；自装写入指定的 fullchain / privkey 路径。"),
    baotaDir,
    baotaFull,
    baotaKey,
    customFull,
    customKey,
    field("nginxBin", bin, "nginx 可执行文件。宝塔可空，自装必填。nginx -t 通过后才 reload。"),
  ]);
  item.dataset.type = "nginx";
  item._summary = () => (kind.value === "baota" ? certDir.value.trim() : fullchain.value.trim());
  item._collect = () => {
    if (kind.value === "baota") {
      return {
        type: "nginx",
        kind: "baota",
        certDir: certDir.value.trim(),
        fullchainName: fullchainName.value.trim() || undefined,
        privkeyName: privkeyName.value.trim() || undefined,
        nginxBin: bin.value.trim() || undefined,
      };
    }
    return {
      type: "nginx",
      kind: "custom",
      fullchainPath: fullchain.value.trim(),
      privkeyPath: privkey.value.trim(),
      nginxBin: bin.value.trim() || undefined,
    };
  };
  remove.addEventListener("click", () => {
    item.remove();
    onChange();
  });
  kind.addEventListener("change", syncKind);
  certDir.addEventListener("input", onChange);
  fullchain.addEventListener("input", onChange);
  syncKind();
  return item;
}

function cdnCard(action, onChange) {
  const domains = el("input", { value: (action.domainNames || []).join(", ") });
  const title = el("span", { class: "accordion-title", text: "CDN" });
  const remove = iconButton("删除", "trash", "ghost");
  const item = makeAccordion(title, [remove], [
    field("加速域名（逗号分隔）", domains, "须已在 CDN 上存在并开通 HTTPS。每个名字必须被本证书覆盖。"),
  ]);
  item.dataset.type = "aliyun-cdn";
  item._summary = () => domains.value.trim();
  item._collect = () => ({
    type: "aliyun-cdn",
    domainNames: domains.value.split(",").map((part) => part.trim()).filter(Boolean),
  });
  remove.addEventListener("click", () => {
    item.remove();
    onChange();
  });
  domains.addEventListener("input", onChange);
  return item;
}

function applyCard(action, onChange) {
  return action.type === "aliyun-cdn" ? cdnCard(action, onChange) : nginxCard(action, onChange);
}

function jobCard(job) {
  const id = el("input", { value: job.id || "" });
  const enabled = el("input", { type: "checkbox" });
  enabled.checked = job.enabled !== false;
  const domains = el("input", { value: (job.domains || []).join(", ") });
  const challenge = el("select", {}, [
    el("option", { value: "dns-01", text: "dns-01" }),
    el("option", { value: "http-01", text: "http-01" }),
  ]);
  challenge.value = job.challenge?.type || "dns-01";
  const zone = el("input", { value: job.challenge?.zone || "" });
  const webroot = el("input", { value: job.challenge?.webroot || "" });
  const wait = el("input", { type: "number", min: "1", value: String(job.challenge?.propagationSeconds ?? 60) });
  const credential = el("input", { value: job.credential || "", placeholder: "default" });
  const hook = el("input", { value: job.hook?.command || "" });
  const hookWait = el("input", { type: "number", min: "1", value: String(job.hook?.timeoutSeconds ?? 60) });
  const title = el("span", { class: "accordion-title", text: jobTitle(job.id, (job.domains || []).join(", ")) });
  const applyList = el("div", { class: "accordion-stack nested" });
  const zoneField = field("zone", zone, "阿里云解析里的主域名，程序不猜根域。本任务所有名字都必须在这个 zone 下。");
  const webrootField = field("webroot", webroot, "校验文件写入的目录，默认 /var/www/acme。须已挂进容器，Nginx 能用 HTTP 提供。");
  const waitField = field("DNS 等待秒", wait, "最后一个 TXT 写完后等待的秒数，0–3600，默认 60。");

  function syncChallenge() {
    const dns = challenge.value === "dns-01";
    zoneField.hidden = !dns;
    waitField.hidden = !dns;
    webrootField.hidden = dns;
  }
  challenge.addEventListener("change", syncChallenge);
  syncChallenge();

  function syncTitle() {
    title.textContent = jobTitle(id.value, domains.value);
  }
  id.addEventListener("input", syncTitle);
  domains.addEventListener("input", syncTitle);

  function refreshApplies() {
    retitleApplies(applyList);
  }

  for (const action of job.apply || []) applyList.appendChild(applyCard(action, refreshApplies));
  refreshApplies();

  const addNginx = iconButton("Nginx", "plus", "secondary");
  addNginx.addEventListener("click", () => {
    const card = nginxCard({ type: "nginx", kind: "baota", certDir: "" }, refreshApplies);
    applyList.appendChild(card);
    refreshApplies();
    toggleAccordion(card);
  });
  const addCdn = iconButton("CDN", "plus", "secondary");
  addCdn.addEventListener("click", () => {
    const card = cdnCard({ type: "aliyun-cdn", domainNames: [] }, refreshApplies);
    applyList.appendChild(card);
    refreshApplies();
    toggleAccordion(card);
  });

  const enabledLabel = el("label", { class: "check" }, [enabled, document.createTextNode("启用")]);
  const remove = iconButton("删除任务", "trash", "danger");
  const item = makeAccordion(title, [enabledLabel], [
    el("div", { class: "grid" }, [
      field("任务 id", id, "1–40 位小写字母、数字、连字符，不能以连字符开头或结尾。同时是证书名。"),
      field("域名（逗号分隔）", domains, "至少一个，写在同一张证书上。泛域名写成 *.example.com，必须用 dns-01。"),
      field("校验", challenge, "dns-01 写阿里云 TXT；http-01 走源站 80 端口。有泛域名必须 dns-01。"),
      zoneField,
      webrootField,
      waitField,
      field("凭据名", credential, "对应凭据页的名字，缺省 default。只含字母和数字。"),
      field("签发后命令", hook, "仅本轮真正写出新证书后，在容器内用 /bin/sh -c 执行。可空。"),
      field("命令超时秒", hookWait, "1–300，默认 60。失败不回滚已经完成的 Nginx / CDN。"),
    ]),
    el("div", { class: "row" }, [addNginx, addCdn]),
    applyList,
    el("div", { class: "job-remove" }, [remove]),
  ]);
  remove.addEventListener("click", () => item.remove());
  item._collect = () => ({
    id: id.value.trim(),
    enabled: enabled.checked,
    domains: domains.value.split(",").map((part) => part.trim()).filter(Boolean),
    challenge: challenge.value === "http-01"
      ? { type: "http-01", webroot: webroot.value.trim() || undefined }
      : { type: "dns-01", zone: zone.value.trim(), propagationSeconds: Number(wait.value) || 60 },
    credential: credential.value.trim() || undefined,
    apply: [...applyList.children].map((card) => card._collect()),
    hook: hook.value.trim() ? { command: hook.value.trim(), timeoutSeconds: Number(hookWait.value) || 60 } : undefined,
  });
  return item;
}

async function loadJobs() {
  const message = document.getElementById("jobs-message");
  try {
    const body = await api("/api/config");
    const config = body.config;
    document.getElementById("serverName").value = config.serverName || "";
    document.getElementById("email").value = config.letsencrypt.email || "";
    document.getElementById("staging").checked = Boolean(config.letsencrypt.staging);
    document.getElementById("renewBeforeDays").value = config.letsencrypt.renewBeforeDays;
    document.getElementById("keyType").value = config.letsencrypt.keyType;
    document.getElementById("regionId").value = config.alibaba.regionId || "";
    document.getElementById("hours").value = (config.schedule.hours || []).join(",");
    renderJobs(config.jobs || []);
    const first = document.querySelector("#job-list > .accordion");
    if (first) toggleAccordion(first);
    message.textContent = body.invalidJobs?.length ? `有 ${body.invalidJobs.length} 条任务不合法，表单里看不到它们。` : "";
  } catch (err) {
    message.textContent = err.message;
  }
}

function renderJobs(jobs) {
  const list = document.getElementById("job-list");
  list.replaceChildren();
  jobs.forEach((job) => list.appendChild(jobCard(job)));
}

document.getElementById("add-job").addEventListener("click", () => {
  const jobs = collectJobs();
  jobs.push(emptyJob());
  renderJobs(jobs);
  const last = document.querySelector("#job-list > .accordion:last-child");
  if (last) toggleAccordion(last);
});

document.getElementById("save-jobs").addEventListener("click", async () => {
  const message = document.getElementById("jobs-message");
  try {
    await api("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serverName: document.getElementById("serverName").value.trim(),
        letsencrypt: {
          email: document.getElementById("email").value.trim(),
          staging: document.getElementById("staging").checked,
          renewBeforeDays: Number(document.getElementById("renewBeforeDays").value),
          keyType: document.getElementById("keyType").value,
        },
        alibaba: { regionId: document.getElementById("regionId").value.trim() },
        schedule: {
          hours: document.getElementById("hours").value.split(",").map((part) => Number(part.trim())).filter((n) => Number.isInteger(n)),
        },
        jobs: collectJobs(),
      }),
    });
    message.textContent = "已保存";
    await loadJobs();
  } catch (err) {
    message.textContent = err.body && err.body.invalidJobs
      ? err.body.invalidJobs.map((item) => item.error).join("；")
      : err.message;
  }
});

function collectJobs() {
  return [...document.getElementById("job-list").children].map((card) => card._collect());
}

async function loadYaml() {
  const message = document.getElementById("yaml-message");
  try {
    const body = await api("/api/config/raw");
    document.getElementById("yaml-text").value = body.text || "";
    message.textContent = body.text ? "" : "还没有配置文件。";
  } catch (err) {
    message.textContent = err.message;
  }
}

document.getElementById("reload-yaml").addEventListener("click", loadYaml);
document.getElementById("save-yaml").addEventListener("click", async () => {
  const message = document.getElementById("yaml-message");
  try {
    await api("/api/config/raw", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: document.getElementById("yaml-text").value }),
    });
    message.textContent = "已保存";
  } catch (err) {
    message.textContent = err.message;
  }
});

function closeDialog() {
  document.getElementById("dialog").hidden = true;
  dialogMode = null;
  document.getElementById("dialog-error").textContent = "";
}

function showDialog(mode, title) {
  dialogMode = mode;
  document.getElementById("dialog-title").textContent = title;
  document.getElementById("dialog-error").textContent = "";
  document.getElementById("dialog-cred").classList.toggle("active", mode.startsWith("cred"));
  document.getElementById("dialog-admin").classList.toggle("active", mode.startsWith("admin"));
  document.getElementById("dialog").hidden = false;
  const first = mode.startsWith("cred")
    ? document.getElementById("dialog-cred-name")
    : document.getElementById("dialog-admin-name");
  if (!first.disabled) first.focus();
  else if (mode.startsWith("cred")) document.getElementById("dialog-cred-id").focus();
  else document.getElementById("dialog-admin-password").focus();
}

function openCredDialog(item) {
  const name = document.getElementById("dialog-cred-name");
  const id = document.getElementById("dialog-cred-id");
  const secret = document.getElementById("dialog-cred-secret");
  id.value = "";
  secret.value = "";
  if (item) {
    name.value = item.name;
    name.disabled = true;
    text("dialog-cred-hint", "密钥不会回显。填写后覆盖文件里已保存的值。");
    showDialog("cred-edit", "编辑凭据");
  } else {
    name.value = "";
    name.disabled = false;
    text("dialog-cred-hint", "");
    showDialog("cred-create", "创建凭据");
  }
}

function openAdminDialog(user, me) {
  dialogAdminMe = me;
  const name = document.getElementById("dialog-admin-name");
  const currentWrap = document.getElementById("dialog-admin-current-wrap");
  const current = document.getElementById("dialog-admin-current");
  const password = document.getElementById("dialog-admin-password");
  current.value = "";
  password.value = "";
  if (user) {
    name.value = user.username;
    name.disabled = true;
    const self = user.username === me;
    currentWrap.hidden = !self;
    showDialog("admin-edit", self ? "修改我的口令" : "重设口令");
  } else {
    name.value = "";
    name.disabled = false;
    currentWrap.hidden = true;
    showDialog("admin-create", "创建管理员");
  }
}

document.getElementById("dialog-cancel").addEventListener("click", closeDialog);
document.getElementById("dialog-backdrop").addEventListener("click", closeDialog);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.getElementById("dialog").hidden) closeDialog();
});

document.getElementById("dialog-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("dialog-error");
  error.textContent = "";
  try {
    if (dialogMode === "cred-create" || dialogMode === "cred-edit") {
      await api("/api/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: document.getElementById("dialog-cred-name").value.trim() || "default",
          accessKeyId: document.getElementById("dialog-cred-id").value,
          accessKeySecret: document.getElementById("dialog-cred-secret").value,
        }),
      });
      closeDialog();
      text("cred-message", "已保存");
      await loadCredentials();
      return;
    }
    if (dialogMode === "admin-create") {
      await api("/api/admins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: document.getElementById("dialog-admin-name").value.trim(),
          password: document.getElementById("dialog-admin-password").value,
        }),
      });
      closeDialog();
      text("admins-message", "已添加");
      await loadAdmins();
      return;
    }
    if (dialogMode === "admin-edit") {
      const username = document.getElementById("dialog-admin-name").value.trim();
      const payload = { newPassword: document.getElementById("dialog-admin-password").value };
      if (username === dialogAdminMe) payload.currentPassword = document.getElementById("dialog-admin-current").value;
      else payload.username = username;
      await api("/api/admins/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      closeDialog();
      text("admins-message", "口令已修改");
      await loadAdmins();
    }
  } catch (err) {
    error.textContent = err.message;
  }
});

async function loadCredentials() {
  const message = document.getElementById("cred-message");
  try {
    const body = await api("/api/credentials");
    const tbody = document.getElementById("cred-table");
    tbody.replaceChildren();
    for (const item of body.credentials) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = item.name;
      const source = document.createElement("td");
      source.textContent = item.configured ? (item.source === "file" ? "文件" : "环境变量") : "未配置";
      const actions = document.createElement("td");
      actions.className = "row-actions";
      const edit = iconButton("编辑", "edit", "ghost");
      edit.addEventListener("click", () => openCredDialog(item));
      actions.appendChild(edit);
      if (item.source === "file") {
        const del = iconButton("删除", "trash", "ghost");
        del.addEventListener("click", async () => {
          if (!confirm(`从文件删除凭据 ${item.name}？`)) return;
          try {
            await api("/api/credentials", {
              method: "DELETE",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: item.name }),
            });
            await loadCredentials();
          } catch (err) {
            message.textContent = err.message;
          }
        });
        actions.appendChild(del);
      }
      tr.append(name, source, actions);
      tbody.appendChild(tr);
    }
    message.textContent = "";
  } catch (err) {
    message.textContent = err.message;
  }
}

document.getElementById("create-cred").addEventListener("click", () => openCredDialog(null));

async function loadAdmins() {
  const message = document.getElementById("admins-message");
  try {
    const body = await api("/api/admins");
    const tbody = document.getElementById("admin-table");
    tbody.replaceChildren();
    for (const user of body.users) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = user.username + (user.username === body.me ? "（我）" : "");
      const created = document.createElement("td");
      created.textContent = user.createdAt;
      const actions = document.createElement("td");
      actions.className = "row-actions";
      const edit = iconButton("编辑", "edit", "ghost");
      edit.addEventListener("click", () => openAdminDialog(user, body.me));
      actions.appendChild(edit);
      if (user.username !== body.me) {
        const del = iconButton("删除", "trash", "ghost");
        del.addEventListener("click", async () => {
          if (!confirm(`删除管理员 ${user.username}？`)) return;
          try {
            await api("/api/admins", {
              method: "DELETE",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ username: user.username }),
            });
            await loadAdmins();
          } catch (err) {
            message.textContent = err.message;
          }
        });
        actions.appendChild(del);
      }
      tr.append(name, created, actions);
      tbody.appendChild(tr);
    }
    message.textContent = "";
  } catch (err) {
    message.textContent = err.message;
  }
}

document.getElementById("create-admin").addEventListener("click", () => openAdminDialog(null, ""));

refresh();
setInterval(refresh, 5000);
