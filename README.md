# auto-certificate-renewal

在 Linux 服务器上用 Docker 自动签发、续签 Let’s Encrypt 证书，并应用到本机 Nginx 或阿里云 CDN。

每台机器跑同一个镜像、自己的一份 YAML。程序调用 Certbot 签发，再按任务把证书写到宝塔或自装 Nginx，或上传到阿里云数字证书管理服务后绑定 CDN。校验按任务选择 HTTP-01 或阿里云云解析 DNS-01。泛域名走 DNS-01。

一台机器可以有多条任务。每条任务是一张证书，上面可以写多个域名。一条失败，后面的任务继续。

## 使用前准备

程序只换证书和做校验，站点、解析和云产品账号需要先就绪。

| 准备好 | 说明 |
| --- | --- |
| Linux 上的 Docker，容器能访问 Let’s Encrypt 和阿里云 API | 签发和换证都从容器发起 |
| 域名已在阿里云云解析（用 DNS-01 时） | 程序向该解析区写 `_acme-challenge` TXT，验证后删除 |
| Nginx 站点已经按 HTTPS 配好 | 程序只替换 pem，再执行 `nginx -t` 和 reload |
| 站点配置里的证书路径与任务一致 | 宝塔填 `certDir`；自装 Nginx 填 `fullchainPath` 和 `privkeyPath` |
| 阿里云 CDN 加速域名已经存在并开通 HTTPS（要用 CDN 时） | 程序上传证书再绑定，不创建加速域名 |
| RAM 权限 | 云解析记录读写、`yundun-cert:UploadUserCertificate`、`cdn:SetCdnDomainSSLCertificate`。只用到其中一部分时，按实际任务授权 |

域名已经走 CDN 时用 DNS-01。HTTP-01 只在 Let’s Encrypt 能直接访问这台源站的 80 端口时使用。HTTP-01 要在 Nginx 里提供 `/.well-known/acme-challenge/`，片段见 [docs/配置.md](docs/配置.md)。

更细的换证过程见 [docs/执行流程.md](docs/执行流程.md)。

## 在这台机器上构建并启动

仓库和 Docker 都在要续签的 Linux 上时：

```bash
cp config/config.example.yaml config/config.yaml
cp .env.example .env
```

编辑这两份文件：`config.yaml` 写域名、校验方式和应用动作，`.env` 写阿里云密钥和时区。密钥不要写进 YAML。

```bash
docker compose up -d --build
docker compose logs --tail=100 renew
```

仓库里的 `docker-compose.yml` 使用 `image: auto-certificate-renewal:local` 和 `build: .`。容器起来后先跑一轮，再按时刻表循环。

第一次对真实域名联调时，把 `letsencrypt.staging` 设为 `true`。测试证书不受浏览器信任。确认流程后再改回 `false`。

## 服务器上不放源码

在开发机构建镜像，推到自己的容器镜像服务。服务器上只放三份文件：`docker-compose.yml`、`config/config.yaml`、`.env`。`image` 写成仓库全名，去掉 `build: .`。

登录、构建、推送和服务器上的 compose 示例见 [docs/使用.md](docs/使用.md)。构建架构要和服务器一致，常见 x86_64 用 `linux/amd64`。

## 配置示例

完整字段见 [docs/配置.md](docs/配置.md)，模板是 [config/config.example.yaml](config/config.example.yaml)。

```yaml
serverName: origin-a

letsencrypt:
  email: ops@example.com
  staging: false
  renewBeforeDays: 30
  keyType: ecdsa

alibaba:
  regionId: cn-hangzhou

schedule:
  hours: [3, 15]

jobs:
  - id: www-example
    domains:
      - example.com
      - www.example.com
    challenge:
      type: dns-01
      zone: example.com
      propagationSeconds: 60
    apply:
      - type: nginx
        kind: baota
        certDir: /www/server/panel/vhost/cert/example.com
      - type: aliyun-cdn
        domainNames:
          - example.com
          - www.example.com
```

泛域名写成 `"*.example.com"`，并使用 `dns-01`。YAML 里不加引号时，`*` 会被当成别名，整份配置解析失败。

`certDir` 要和宝塔站点里已有的证书目录一致，例如：

```nginx
ssl_certificate      /www/server/panel/vhost/cert/example.com/fullchain.pem;
ssl_certificate_key  /www/server/panel/vhost/cert/example.com/privkey.pem;
```

只做 DNS-01 和 CDN、这台机器没有 Nginx 时，从 compose 里去掉证书目录和 webroot 两行挂载。自装 Nginx 把证书文件所在目录挂进容器。

## 启动之后

默认命令是 `cert-renew schedule`：

1. 未暂停时，容器每次启动先跑一轮。暂停记在数据卷里，重启后仍然有效，这时启动不跑。
2. 按 `.env` 里的 `TZ`（默认 `Asia/Shanghai`）和 `schedule.hours`（默认 03:00、15:00）再跑。每次进入等待时随机加 0–30 分钟，多台机器错开。
3. 配置读不了时进程退出，方便 compose 重启后重新读挂载。有任务失败时继续按时刻表跑。

证书剩余时间多于 `renewBeforeDays`（默认 30 天），并且 Nginx / CDN 上次都成功：跳过，不调用 Certbot。证书缺失、进入续签窗口或上次签发失败：重新签发。证书没变、只有应用失败：不签发，只重试失败的 Nginx 或 CDN。

`pid: host` 和 `privileged: true` 用来通过 `nsenter` 调用宿主机上的 nginx。HTTP-01 和 DNS-01 都不需要 `network_mode: host`。

下面的命令在放 `docker-compose.yml` 的目录里执行。`<任务id>` 换成 `jobs[].id`，例如 `www-example`。

| 目的 | 命令 |
| --- | --- |
| 后台按时刻表运行 | `docker compose up -d` |
| 看是否在跑 | `docker compose ps` |
| 看日志 | `docker compose logs --tail=200 renew` |
| 立刻跑全部任务一次 | `docker compose run --rm --entrypoint cert-renew renew run` |
| 只跑一条 | `docker compose run --rm --entrypoint cert-renew renew run --job <任务id>` |
| 演练，不改 Nginx / CDN | `docker compose run --rm --entrypoint cert-renew renew run --dry-run` |
| 停止并删除容器，保留数据卷 | `docker compose down` |

`docker compose up -d` 才是长期自动续签。单独的 `run` 多做一轮，跑完就退出，不会关掉正在跑的时刻表容器。时刻表正在写证书时，不要再开一个 `run`。

`--dry-run` 不替换 Nginx、不调用 CDN、不跑钩子。DNS-01 演练时仍可能向阿里云解析写 TXT。

不要执行 `docker compose down -v`。`-v` 会删除 `acme-data`，Let’s Encrypt 账户和已签证书一起丢失，下次签发可能撞上颁发配额。

退出码：`0` 全部成功或跳过；`1` 配置读不了；`2` 至少一条任务失败。

## 状态网页

同一台机器上还有一个 `web` 容器，打开 `http://127.0.0.1:8787`。口令是 `.env` 里的 `WEB_PASSWORD`，至少 12 位。页面看最近一轮、每张证书、Nginx 和 CDN 的结果，以及日志末尾。三个按钮是：立即检查、暂停定时检查、恢复定时检查。

立即检查仍受 `renewBeforeDays` 约束，证书还早就不会重新签发。网页不改配置，也不显示私钥。服务器上的打开方式和暂停规则见 [docs/使用.md](docs/使用.md)。

## 确认是否生效

```bash
docker compose logs --tail=200 renew
docker compose exec renew cat /var/lib/acme/status.json
docker compose exec renew cat /var/lib/acme/state/www-example.json
```

日志末尾有总数、跳过、成功、失败。`status.json` 里看 `exitCode`、每条任务的 `status` 和 `notAfter`。`state/<任务id>.json` 里 `cas.certId` 是数字证书管理服务中的证书，`targets["cdn:example.com"].ok` 为 `true` 表示该加速域名已绑定。

再到阿里云控制台核对证书名称和 CDN 域名上的 CertId。证书还很新时，时刻表只会记跳过。

改域名或密钥：只改服务器上的 `config.yaml` 或 `.env`，然后 `docker compose up -d`。改程序才需要重新构建镜像。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/配置.md](docs/配置.md) | 每个字段、`.env`、HTTP-01 的 Nginx 片段 |
| [docs/使用.md](docs/使用.md) | 构建并推送镜像、服务器目录、更新镜像、本机测试 |
| [docs/执行流程.md](docs/执行流程.md) | 一轮里如何决定签发或跳过，Nginx / CDN 如何换证 |
| [docs/源码.md](docs/源码.md) | 模块和导出函数 |
| [docs/项目说明.md](docs/项目说明.md) | 改代码前看的约束 |
| [docs/目标.md](docs/目标.md) | 还没有做的多机汇总、配置下发、通知和多机共用证书 |
| [AGENTS.md](AGENTS.md) | 公开仓库不能提交的内容 |

## 开发

需要 Node.js 24.22.1 或同一条 24 线上的更高版本。

```bash
npm ci
npm test
```

测试不访问 Let’s Encrypt，也不调用阿里云。

## 公开仓库

本仓库是公开的。AccessKey、真实域名、真实邮箱、服务器 IP、真实镜像仓库地址只放在已被忽略的 `.env` 和 `config/config.yaml`，以及服务器上不入库的 compose。文档和示例使用 `example.com`、`ops@example.com`、`<ACR域名>`。
