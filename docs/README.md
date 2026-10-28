# 文档目录

| 文档 | 内容 |
| --- | --- |
| [项目说明.md](项目说明.md) | 项目是什么、目录、已定约束、开源红线；后续改代码先看这篇 |
| [配置.md](配置.md) | 配置文件放哪、怎么复制、每个字段怎么写、`.env` 密钥 |
| [使用.md](使用.md) | 本机构建推镜像、服务器启动、时刻表、命令、怎么确认续签和 CDN |
| [执行流程.md](执行流程.md) | 根据什么做决定、一轮做什么、Nginx / 阿里云怎么换证、哪些要人先配好 |
| [源码.md](源码.md) | 模块职责、每个导出函数做什么 |
| [v1-目标.md](v1-目标.md) | 第一期目标、范围、一条任务怎么跑 |

仓库根目录 [AGENTS.md](../AGENTS.md) 约束后续实现和文档：公开仓库不放敏感内容。

本机配置从模板复制：

```bash
cp config/config.example.yaml config/config.yaml
cp .env.example .env
```

`config/config.yaml` 由 compose 挂到容器内 `/config/config.yaml`，程序默认读这条路径。
