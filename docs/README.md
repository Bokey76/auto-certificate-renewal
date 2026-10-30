# 文档目录

使用者从仓库根目录 [README.md](../README.md) 开始。这里是分册。

| 文档 | 内容 |
| --- | --- |
| [配置.md](配置.md) | 配置文件放哪、每个字段怎么写、`.env` 密钥 |
| [使用.md](使用.md) | 本机构建推镜像、服务器启动、时刻表、命令、怎么确认续签和 CDN |
| [执行流程.md](执行流程.md) | 根据什么做决定、一轮做什么、Nginx / 阿里云怎么换证 |
| [源码.md](源码.md) | 模块职责、每个导出函数做什么 |
| [项目说明.md](项目说明.md) | 目录、已定约束；后续改代码先看这篇 |
| [目标.md](目标.md) | 还没有做的多机汇总、配置下发、通知和多机共用证书 |

仓库根目录 [AGENTS.md](../AGENTS.md) 约束后续实现和文档：公开仓库不放敏感内容。

本机配置从模板复制：

```bash
cp config/config.example.yaml config/config.yaml
cp .env.example .env
```

`config/config.yaml` 由 compose 挂到容器内 `/config/config.yaml`，程序默认读这条路径。
