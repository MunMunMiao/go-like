---
"@go-like/cache": minor
"@go-like/registry": minor
"@go-like/store": minor
"@go-like/transport": minor
---

将 provider conformance helpers 收回 workspace 内部，删除四个公共 `./testing` 子路径。应用只需要学习
各能力域的生产 SPI，第三方 provider 测试不再成为运行时发布面；实现者使用独立的 `./provider` 子路径，
provider 校验与 wire helper 不再污染应用入口。
