# 网页控制台

同一台机器上的 `web` 容器提供控制台：看状态、改配置、管理管理员和阿里云凭据，以及立即检查、只跑一条、演练、强制续签、暂停或恢复。字段含义见 [配置.md](配置.md)。一轮里如何换证见 [执行流程.md](执行流程.md)。命令行部署见 [使用.md](使用.md)。

网页和时刻表共用 `./config` 与 `./data`。点「立即检查」是给正在跑的 `renew` 进程留一张请求，由它执行；不会另开一轮 Certbot。`dns-auth` / `dns-cleanup` 是 Certbot 钩子，网页没有对应按钮，也不要手工调用。

## 打开

`docker compose up -d` 会同时拉起 `web`。页面绑在服务器本机 `127.0.0.1:8787`，不对外网开放。

在自己的电脑上转发过去再打开：

```bash
ssh -L 8787:127.0.0.1:8787 <用户>@<服务器>
```

浏览器访问 `http://127.0.0.1:8787`。

要挂到已有的 HTTPS 反代上时，把发布地址改成内网，并在 `.env` 设 `WEB_COOKIE_SECURE=true`。仓库里的 compose 示例不这么做。

`web` 不设 `privileged`，也不挂证书目录。端口可用环境变量 `WEB_PORT` 改（默认 8787）。

## Windows 本机调试

Windows 上可以跑控制台和单元测试，用来看页面、改配置、验证接口。真正签发、写 Nginx、调阿里云 API 要在 Linux 上跑 `renew` 容器。

程序默认读容器路径 `/config/config.yaml` 和 `/var/lib/acme`，本机必须改成仓库里的文件。`.nvmrc` 写的是 Node `24.22.1`；若 nvm-windows 里还没有这个版本，用已安装的 24.21.x，把该版本的目录放到 PATH 最前面。PowerShell 里用 `npm.cmd`，不要用 `npm.ps1`。

```powershell
cd <仓库根目录>
Copy-Item -Force .env.example .env
if (-not (Test-Path data)) { New-Item -ItemType Directory data }
if (-not (Test-Path config\config.yaml)) { Copy-Item config\config.example.yaml config\config.yaml }

$env:PATH = "<Node 24 安装目录>;" + $env:PATH
$env:CONFIG_PATH = "$PWD\config\config.yaml"
$env:CERT_RENEW_DATA_DIR = "$PWD\data"

npm.cmd install
npm.cmd run build
node dist/cli.js web
```

浏览器打开 `http://127.0.0.1:8787`。第一次打开创建管理员（口令至少 12 位），账号写到 `config/admins.json`。已经有管理员时进入登录页。

| 改了什么 | 怎么看到 |
| --- | --- |
| `web/` 下的 HTML / CSS / JS | 刷新浏览器 |
| `src/` 下的 TypeScript | 再执行 `npm.cmd run build`，停掉 `web` 后重新 `node dist/cli.js web` |
| 逻辑是否正确 | `npm.cmd test`（不访问 Let’s Encrypt 和阿里云） |

`npm test` 把日志写到临时目录，不会出现在 `data/logs/`。`node dist/cli.js web` 只起控制台，不会跑 Certbot，也就不会产生新的一轮日志。状态页要看到「加载更多 / 下载」，`data/logs/` 里需要已有 `.log` 文件：从服务器拷 `data/logs/`，或在本机造一份（250 行以上才能点「加载更多」）：

```powershell
New-Item -ItemType Directory -Force data\logs | Out-Null
node -e "const fs=require('fs');const p='data/logs';fs.mkdirSync(p,{recursive:true});const n='2026-11-03T03-00-00.000Z.log';const lines=Array.from({length:250},(_,i)=>'2026-11-03T03:00:00.000Z [-] line-'+String(i+1).padStart(3,'0'));fs.writeFileSync(p+'/'+n,lines.join('\n')+'\n');fs.writeFileSync('data/status.json',JSON.stringify({serverName:'origin-a',startedAt:'2026-11-03T03:00:00.000Z',finishedAt:'2026-11-03T03:00:02.000Z',exitCode:0,logPath:require('path').resolve(p,n),jobs:[]},null,2)+'\n');"
```

造完后刷新状态页。网页上的「立即检查」只给时刻表进程留一张请求。本机没有 Linux 的 `renew` 容器时，请求会写在 `data/control/run-request`，不会真正签发。

本机直接打开 `http://127.0.0.1:8787`，不要设 `WEB_COOKIE_SECURE=true`。

## 第一次使用

`config/admins.json` 不存在或里面没有用户时，打开网页是初始化页。填写用户名和口令（至少 12 位）后写入该文件，并自动登录。之后可在「管理员」里加人。

用户名：1–40 位字母、数字、下划线或连字符，不能以下划线或连字符开头或结尾。

连续输错口令会暂时拦住。会话存在网页进程内存里，重启 `web` 容器需要重新登录。

## 页面

登录后五个标签：

| 标签 | 内容 |
| --- | --- |
| 状态 | 调度是否在跑、下次检查、最近一轮、每条任务的到期和 Nginx / CDN、日志。立即检查、暂停、恢复。日志下拉可选更早的一轮 |
| 任务 | 嵌套口风琴：全局配置、任务列表；每条任务下的 Nginx / CDN 各自展开收起。保存写回 `config.yaml` |
| YAML | 同一份 `config.yaml` 的原文。适合保留注释或一次改多处 |
| 凭据 | 填写或删除阿里云 AccessKey。列表只显示名称和来源，不显示密钥 |
| 管理员 | 加人、删人、改自己的口令 |

状态页大约每 5 秒刷新一次。切到其它标签时才拉对应数据。

日志在 `data/logs/`，每轮一个文件。状态下拉列出最近 50 个，标签是该轮开始时刻。默认看本轮（`status.json` 指向的那份），内容随刷新更新。选更早的文件后会钉住，不会被 5 秒刷新拉回本轮；那份文件从列表消失时才回到本轮。默认显示末尾 200 行；「加载更多」每次再往前 500 行，可以一直加到文件开头。「下载本文件」拿到全文。网页只按裸文件名读 `logs/` 里的 `.log`，不能指定路径。

表单保存会重排 YAML，原文注释不会保留。要留注释用 YAML 页。校验失败时不会写盘，页面会显示原因。

签发后钩子是任意 shell，由 `renew` 进程在容器内执行。不要在钩子里做会长时间卡住一轮的事。

## 操作和命令对照

网页上的检查、暂停写到 `data/control/`，由正在跑的时刻表进程消费，不会另开 Certbot。下面「命令行另开一轮」是再起一个短生命周期容器，多做一轮后退出，不会关掉正在跑的 `renew`。两套不要同时用：时刻表正在写证书时，不要再开一个 `run`。

下面都在放 `docker-compose.yml` 的目录里执行。`<任务id>` 换成 `jobs[].id`。

| 网页 | 做什么 | 命令行另开一轮（效果相近，机制不同） |
| --- | --- | --- |
| 立即检查 | 给正在跑的 `renew` 留一张请求，由它再跑全部任务一次。仍受 `renewBeforeDays` 约束 | `docker compose run --rm --entrypoint cert-renew renew run` |
| 跑这一条 | 同上，请求里带这一条任务的 `id` | `docker compose run --rm --entrypoint cert-renew renew run --job <任务id>` |
| 勾选演练再检查 | 不改 Nginx / CDN、不跑钩子。DNS-01 仍可能写 TXT | 上面的命令加上 `--dry-run` |
| 勾选强制续签再检查 | 忽略 `renewBeforeDays`，仍走 Certbot | 上面的命令加上 `--force` |
| 暂停定时检查 | 到点不再跑。`data/` 记得这件事，容器重启后仍然暂停。正在跑的那一轮会跑完 | 无对应子命令（写 `data/control/paused`） |
| 恢复定时检查 | 恢复到点检查，本身不多跑一轮 | 删除暂停标记 |
| 保存任务 / YAML | 写回 `config/config.yaml`。下次检查或立即检查会读到新配置 | 手工编辑同一文件 |
| 保存凭据 | 写 `config/credentials.json`，签发时优先于 `.env` | 在 `.env` 写 `ALIBABA_CLOUD_ACCESS_KEY_ID` 等作后备 |
| 添加 / 删除管理员 | 写 `config/admins.json` | 无对应子命令 |

暂停期间仍可以按立即检查。调度进程没在跑时，按钮会把操作记下，等 `renew` 起来才执行。已经有一张未执行的检查请求时，再点一次不会覆盖。

演练和强制续签是状态页上的勾选，和「立即检查」或「跑这一条」一起生效。

## 网页会写哪些文件

| 文件 | 谁写 | 内容 |
| --- | --- | --- |
| `config/config.yaml` | 网页 | 任务配置 |
| `config/admins.json` | 网页 | 管理员（口令哈希） |
| `config/credentials.json` | 网页 | 阿里云 AccessKey |
| `data/control/paused` | 网页 | 存在即暂停 |
| `data/control/run-request` | 网页创建，`renew` 取走 | `{ at, jobId, dryRun, force }` |
| `data/scheduler.json` | `renew` | 心跳和下次检查。网页只读 |
| `data/status.json`、`data/state/`、`data/logs/` | `renew` | 最近一轮和证书状态。网页只读 |

网页不读 `data/letsencrypt/`，也不显示私钥和 AccessKey。

## 只有命令行才有的操作

| 目的 | 命令 |
| --- | --- |
| 后台按时刻表运行 | `docker compose up -d` |
| 看是否在跑 | `docker compose ps` |
| 看日志 | `docker compose logs --tail=200 renew` |
| 停掉并删容器，保留 `./config` 和 `./data` | `docker compose down` |
| Certbot DNS 钩子 | `cert-renew dns-auth` / `cert-renew dns-cleanup`（由 Certbot 调用） |

镜像里的子命令是 `cert-renew schedule`（默认）、`cert-renew run`、`cert-renew web`，以及上面两个钩子。
