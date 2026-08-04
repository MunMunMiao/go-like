# go-like

go-like 是一套给 TypeScript 后端用的 Go 风格微服务工具包。它把生命周期、Context、服务调用、服务发现、消息、配置、存储、健康检查和可观测性拆成小而清楚的包，不要求你把现有框架或运行时整套换掉。

可移植代码只依赖标准 Web API，例如 `Request`、`Response`、`Headers`、`AbortSignal`、Web Streams 和注入的 `fetch`。Node.js、Bun、Deno 各自特有的能力会放到单独入口。已经导出 Fetch 的框架不需要 go-like 适配包：Hono、Elysia 与 H3 2.x 的 `app.fetch` 可直接交给 `@go-like/web`；H3 1.x 使用 `toWebHandler(app)`。Croner、BullMQ、NATS、Pino、Winston 等资源才使用生命周期适配器。

第一次看可以从[快速开始](/zh-Hans/guide/getting-started)读起，再按[诊所预约：从 0 到 1](/zh-Hans/guide/zero-to-one)按里程碑走一遍引导项目。已经有现成服务要接入时，看[迁移与接入](/zh-Hans/guide/migration)；想知道 go-like 和其他工具各自负责什么，翻[工具比较](/zh-Hans/guide/comparison)。

想知道每个包和 provider 到底管什么，就看[包与 provider 参考](/zh-Hans/reference/providers)和[包参考](/zh-Hans/reference/packages)；想确认哪些能力真的跑过测试，而不是“理论上能用”，请看[验证](/zh-Hans/reference/verification)。

## 选择阅读路径

- **初学者：** 从[快速开始](/zh-Hans/guide/getting-started)到[诊所预约项目](/zh-Hans/guide/zero-to-one)，先跑通 Handler、ready 信号和停止。
- **TypeScript 或 Go 专家：** 先看[架构](/zh-Hans/guide/architecture)，再看[服务调用](/zh-Hans/guide/service-call)和[包与 provider 参考](/zh-Hans/reference/providers)，重点确认 ownership 和终态。
- **框架用户：** 先看[工具比较](/zh-Hans/guide/comparison)，再看[迁移与接入](/zh-Hans/guide/migration)，保留原有 router，只接入需要的边界。

## 这里说的 Go 风格

阻塞操作把 Context 放在第一个参数，资源所有权写清楚，停止后有稳定的终态，小接口靠结构类型实现。它不是把 Go 的大小写、channel 或 goroutine 生搬硬套到 TypeScript；TS 该怎么导出就怎么导出，第三方库独有的语义也继续留在原生对象上。
