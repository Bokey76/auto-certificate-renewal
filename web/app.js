const csrf = document.querySelector('meta[name="csrf-token"]').getAttribute("content");

function text(id, value) {
  document.getElementById(id).textContent = value || "";
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

async function refresh() {
  try {
    const view = await api("/api/overview");
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
      const runOne = document.createElement("button");
      runOne.type = "button";
      runOne.textContent = "跑这一条";
      runOne.addEventListener("click", () => act("/api/run", { jobId: job.id }));
      actions.appendChild(runOne);
      tr.append(name, status, expiry, apply, actions);
      tbody.appendChild(tr);
    }
    const log = document.getElementById("log");
    log.textContent = view.log.lines.join("\n") || view.log.message || "";
  } catch (err) {
    if (err.message !== "unauthorized") text("action-message", "状态没有刷新。");
  }
}

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

function field(labelText, control) {
  const wrap = document.createElement("div");
  const lab = document.createElement("label");
  lab.textContent = labelText;
  wrap.append(lab, control);
  return wrap;
}

function input(value, attrs) {
  const node = document.createElement("input");
  if (attrs) Object.entries(attrs).forEach(([key, val]) => node.setAttribute(key, val));
  node.value = value == null ? "" : String(value);
  return node;
}

let jobState = { serverName: "", letsencrypt: {}, alibaba: {}, schedule: {}, jobs: [] };

async function loadJobs() {
  const message = document.getElementById("jobs-message");
  try {
    const body = await api("/api/config");
    if (!body.ok) {
      message.textContent = body.error || "配置读不了";
      return;
    }
    jobState = body.config;
    if (!Array.isArray(jobState.jobs)) jobState.jobs = [];
    fillRoot();
    renderJobs();
    message.textContent = body.invalidJobs && body.invalidJobs.length
      ? body.invalidJobs.map((item) => item.error).join("；")
      : "";
  } catch (err) {
    message.textContent = err.message;
  }
}

function fillRoot() {
  document.getElementById("serverName").value = jobState.serverName || "";
  document.getElementById("email").value = (jobState.letsencrypt && jobState.letsencrypt.email) || "";
  document.getElementById("regionId").value = (jobState.alibaba && jobState.alibaba.regionId) || "";
  document.getElementById("hours").value = ((jobState.schedule && jobState.schedule.hours) || []).join(",");
  document.getElementById("renewBeforeDays").value = (jobState.letsencrypt && jobState.letsencrypt.renewBeforeDays) || 30;
  document.getElementById("keyType").value = (jobState.letsencrypt && jobState.letsencrypt.keyType) || "ecdsa";
  document.getElementById("staging").checked = Boolean(jobState.letsencrypt && jobState.letsencrypt.staging);
}

function collectRoot() {
  const hours = document.getElementById("hours").value.split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item >= 0 && item <= 23);
  return {
    serverName: document.getElementById("serverName").value.trim() || undefined,
    letsencrypt: {
      email: document.getElementById("email").value.trim(),
      staging: document.getElementById("staging").checked,
      renewBeforeDays: Number(document.getElementById("renewBeforeDays").value),
      keyType: document.getElementById("keyType").value,
    },
    alibaba: { regionId: document.getElementById("regionId").value.trim() },
    schedule: { hours },
    jobs: collectJobs(),
  };
}

function renderJobs() {
  const list = document.getElementById("job-list");
  list.replaceChildren();
  jobState.jobs.forEach((job, index) => list.appendChild(jobCard(job, index)));
}

function jobCard(job, index) {
  const card = el("div", { class: "job" });
  const id = input(job.id);
  id.dataset.field = "id";
  const enabled = input("", { type: "checkbox" });
  enabled.checked = job.enabled !== false;
  const domains = document.createElement("textarea");
  domains.value = (job.domains || []).join("\n");
  const type = document.createElement("select");
  type.append(new Option("dns-01", "dns-01"), new Option("http-01", "http-01"));
  type.value = job.challenge && job.challenge.type === "http-01" ? "http-01" : "dns-01";
  const zone = input(job.challenge && job.challenge.zone);
  const webroot = input((job.challenge && job.challenge.webroot) || "/var/www/acme");
  const propagation = input(job.challenge && job.challenge.propagationSeconds != null ? job.challenge.propagationSeconds : 60, { type: "number" });
  const credential = input(job.credential || "");
  const hookOn = input("", { type: "checkbox" });
  hookOn.checked = Boolean(job.hook);
  const hookCmd = input(job.hook && job.hook.command);
  const hookTimeout = input((job.hook && job.hook.timeoutSeconds) || 60, { type: "number" });
  const applyBox = el("div");
  function renderApply() {
    applyBox.replaceChildren();
    (job.apply || []).forEach((action, actionIndex) => {
      applyBox.appendChild(actionCard(job, action, actionIndex, renderApply));
    });
  }
  renderApply();
  const addNginx = el("button", { type: "button", class: "secondary", text: "添加宝塔 Nginx" });
  addNginx.addEventListener("click", () => {
    job.apply = job.apply || [];
    job.apply.push({ type: "nginx", kind: "baota", certDir: "" });
    renderApply();
  });
  const addCustom = el("button", { type: "button", class: "secondary", text: "添加自装 Nginx" });
  addCustom.addEventListener("click", () => {
    job.apply = job.apply || [];
    job.apply.push({ type: "nginx", kind: "custom", fullchainPath: "", privkeyPath: "", nginxBin: "/usr/sbin/nginx" });
    renderApply();
  });
  const addCdn = el("button", { type: "button", class: "secondary", text: "添加 CDN" });
  addCdn.addEventListener("click", () => {
    job.apply = job.apply || [];
    job.apply.push({ type: "aliyun-cdn", domainNames: [] });
    renderApply();
  });
  const remove = el("button", { type: "button", class: "danger", text: "删除任务" });
  remove.addEventListener("click", () => {
    jobState.jobs.splice(index, 1);
    renderJobs();
  });
  card.append(
    field("任务 id", id),
    el("label", { class: "check" }, [enabled, document.createTextNode(" 启用")]),
    field("域名（一行一个）", domains),
    field("校验方式", type),
    field("DNS zone", zone),
    field("HTTP webroot", webroot),
    field("DNS 传播秒数", propagation),
    field("凭据名（空为 default）", credential),
    el("label", { class: "check" }, [hookOn, document.createTextNode(" 签发后钩子（任意 shell）")]),
    field("钩子命令", hookCmd),
    field("钩子超时秒", hookTimeout),
    applyBox,
    el("div", { class: "actions" }, [addNginx, addCustom, addCdn, remove]),
  );
  card._collect = () => {
    const challenge = type.value === "http-01"
      ? { type: "http-01", webroot: webroot.value.trim() }
      : { type: "dns-01", zone: zone.value.trim(), propagationSeconds: Number(propagation.value) };
    const collected = {
      id: id.value.trim(),
      enabled: enabled.checked,
      domains: domains.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
      challenge,
      apply: (job.apply || []).map((action, actionIndex) => actionCardCollect(applyBox, action, actionIndex)),
    };
    if (credential.value.trim()) collected.credential = credential.value.trim();
    if (hookOn.checked) collected.hook = { command: hookCmd.value, timeoutSeconds: Number(hookTimeout.value) };
    return collected;
  };
  return card;
}

function actionCard(job, action, actionIndex, rerender) {
  const box = el("div", { class: "job" });
  const remove = el("button", { type: "button", class: "danger", text: "删除动作" });
  remove.addEventListener("click", () => {
    job.apply.splice(actionIndex, 1);
    rerender();
  });
  if (action.type === "aliyun-cdn") {
    const domains = document.createElement("textarea");
    domains.value = (action.domainNames || []).join("\n");
    domains.dataset.kind = "cdn";
    box.append(el("p", { text: "阿里云 CDN" }), field("加速域名（一行一个）", domains), remove);
    return box;
  }
  if (action.kind === "custom") {
    const fullchain = input(action.fullchainPath || "");
    const privkey = input(action.privkeyPath || "");
    const bin = input(action.nginxBin || "/usr/sbin/nginx");
    fullchain.dataset.kind = "fullchain";
    privkey.dataset.kind = "privkey";
    bin.dataset.kind = "bin";
    box.append(el("p", { text: "自装 Nginx" }), field("fullchainPath", fullchain), field("privkeyPath", privkey), field("nginxBin", bin), remove);
    return box;
  }
  const certDir = input(action.certDir || "");
  certDir.dataset.kind = "certDir";
  box.append(el("p", { text: "宝塔 Nginx" }), field("certDir", certDir), remove);
  return box;
}

function actionCardCollect(applyBox, action, actionIndex) {
  const box = applyBox.children[actionIndex];
  if (action.type === "aliyun-cdn") {
    const domains = box.querySelector("textarea");
    return { type: "aliyun-cdn", domainNames: domains.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) };
  }
  if (action.kind === "custom") {
    return {
      type: "nginx",
      kind: "custom",
      fullchainPath: box.querySelector('[data-kind="fullchain"]').value.trim(),
      privkeyPath: box.querySelector('[data-kind="privkey"]').value.trim(),
      nginxBin: box.querySelector('[data-kind="bin"]').value.trim(),
    };
  }
  return { type: "nginx", kind: "baota", certDir: box.querySelector('[data-kind="certDir"]').value.trim() };
}

function collectJobs() {
  return [...document.getElementById("job-list").children].map((card) => card._collect());
}

document.getElementById("add-job").addEventListener("click", () => {
  jobState.jobs.push(emptyJob());
  renderJobs();
});

document.getElementById("save-jobs").addEventListener("click", async () => {
  const message = document.getElementById("jobs-message");
  try {
    await api("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collectRoot()),
    });
    message.textContent = "已保存";
    await loadJobs();
  } catch (err) {
    message.textContent = err.message;
  }
});

async function loadYaml() {
  const message = document.getElementById("yaml-message");
  try {
    const body = await api("/api/config/raw");
    document.getElementById("yaml-text").value = body.text || "";
    message.textContent = "";
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
      if (item.source === "file") {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "danger";
        del.textContent = "从文件删除";
        del.addEventListener("click", async () => {
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

document.getElementById("save-cred").addEventListener("click", async () => {
  const message = document.getElementById("cred-message");
  try {
    await api("/api/credentials", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: document.getElementById("cred-name").value.trim() || "default",
        accessKeyId: document.getElementById("cred-id").value,
        accessKeySecret: document.getElementById("cred-secret").value,
      }),
    });
    document.getElementById("cred-id").value = "";
    document.getElementById("cred-secret").value = "";
    message.textContent = "已保存";
    await loadCredentials();
  } catch (err) {
    message.textContent = err.message;
  }
});

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
      if (user.username !== body.me) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "danger";
        del.textContent = "删除";
        del.addEventListener("click", async () => {
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

document.getElementById("add-admin").addEventListener("click", async () => {
  const message = document.getElementById("admins-message");
  try {
    await api("/api/admins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("new-admin").value.trim(),
        password: document.getElementById("new-admin-password").value,
      }),
    });
    document.getElementById("new-admin").value = "";
    document.getElementById("new-admin-password").value = "";
    message.textContent = "已添加";
    await loadAdmins();
  } catch (err) {
    message.textContent = err.message;
  }
});

document.getElementById("change-password").addEventListener("click", async () => {
  const message = document.getElementById("admins-message");
  try {
    await api("/api/admins/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        currentPassword: document.getElementById("old-password").value,
        newPassword: document.getElementById("new-password").value,
      }),
    });
    document.getElementById("old-password").value = "";
    document.getElementById("new-password").value = "";
    message.textContent = "口令已修改";
  } catch (err) {
    message.textContent = err.message;
  }
});

refresh();
setInterval(refresh, 5000);
