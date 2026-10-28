# auto-certificate-renewal

用 Let’s Encrypt 和 Certbot 在多台服务器上按配置签发、续签证书，并应用到宝塔 Nginx、自装 Nginx 和阿里云 CDN。

使用前复制模板：

```bash
cp config/config.example.yaml config/config.yaml
cp .env.example .env
```

说明都在 [docs](docs/README.md)：

- [项目说明（后续改代码先看）](docs/项目说明.md)
- [配置怎么写](docs/配置.md)
- [本机构建推镜像、怎么启动](docs/使用.md)
- [执行流程：先配什么、根据什么做、怎么换证](docs/执行流程.md)
- [每个模块和函数做什么](docs/源码.md)
- [第一期目标](docs/v1-目标.md)

本仓库是公开开源项目，不要提交密钥、真实域名或真实镜像仓库地址。规则见 [AGENTS.md](AGENTS.md)。
