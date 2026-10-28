# 本仓库规则

公开开源项目。后续改代码、写文档、补示例，都按这里做。项目全貌见 [docs/项目说明.md](docs/项目说明.md)。

## 不能放敏感内容

禁止写入会提交的任何文件（源码、测试、文档、示例 YAML、compose、注释、提交说明）：

- AccessKey、AccessKey Secret、密码、Token
- `.env` 的真实值、真实 `config.yaml`
- 真实容器镜像服务实例地址（例如 `crpi-….personal.cr.aliyuncs.com`）
- 真实业务域名、个人邮箱、服务器 IP、主机名
- 真实证书、私钥、Let’s Encrypt 账户文件

文档和示例只用占位符：`example.com`、`ops@example.com`、`<ACR域名>`、`<命名空间>`、空的 `.env.example`。地域示例用 `cn-hangzhou`。

真实配置只出现在已被 `.gitignore` 排除的 `.env`、`config/config.yaml`，以及服务器上不提交的 compose。Docker 镜像不打进密钥和域名配置。

改完文档或示例后搜索：真实域名、`crpi-`、`LTAI`、非空 `ALIBABA_CLOUD_ACCESS_KEY`。

不要放宽 `.gitignore` 对 `.env`、`config/config.yaml`、`*.pem`、`*.key` 的忽略。

## 实现范围

- 第一期：单机 Docker，YAML 驱动，Certbot，宝塔/自装 Nginx，阿里云 CDN 内容分发，阿里云 DNS-01
- 第二期控制机和网页：用户没要求就不要做
- 不实现 ACME，不改 Nginx server 块，不写宝塔数据库，不删 CAS 旧证，不创建 CDN 域名

不要改写 [docs/v1-目标.md](docs/v1-目标.md) 正文，除非发现与实现不符的规格错误。操作说明写到 `docs/` 其它文件。

## 代码与文档

- 文档和用户可见注释用中文，整理到 `docs/`
- 配置模板是 `config/config.example.yaml`，使用时复制为 `config/config.yaml`
- Node.js `>=24.22.1`
- 测试不访问 Let’s Encrypt 和阿里云。提交前 `npm test`
