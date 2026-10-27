# 文档目录

| 文档 | 内容 |
| --- | --- |
| [配置.md](配置.md) | 配置文件放哪、怎么复制、每个字段怎么写、`.env` 密钥 |
| [使用.md](使用.md) | 启动、时刻表、命令、怎么确认续签和 CDN、联调 |
| [源码.md](源码.md) | 模块职责、每个导出函数做什么 |
| [v1-目标.md](v1-目标.md) | 第一期目标、范围、一条任务怎么跑 |

本机配置从模板复制：

```bash
cp config/config.example.yaml config/config.yaml
cp .env.example .env
```

`config/config.yaml` 由 compose 挂到容器内 `/config/config.yaml`，程序默认读这条路径。
