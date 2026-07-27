# LikeGo

LikeGo 是一套给 TypeScript 后端用的 Go 风格微服务工具包。它把生命周期、Context、服务调用、服务发现、消息、配置、存储、健康检查和可观测性拆成小而清楚的包，不要求你把现有框架或运行时整套换掉。

可移植代码只依赖标准 Web API，例如 `Request`、`Response`、`Headers`、`AbortSignal`、Web Streams 和注入的 `fetch`。Node.js、Bun、Deno 各自特有的能力会放到单独入口。你照样可以用 Hono、Elysia、H3、Croner、BullMQ、NATS、Pino 或 Winston，LikeGo 只负责把它们接进统一的生命周期。

第一次看可以从[快速开始](/zh-Hans/guide/getting-started)读起，再看[架构](/zh-Hans/guide/architecture)。想知道每个包到底管什么，就翻[包参考](/zh-Hans/reference/packages)；想确认哪些能力真的跑过测试，而不是“理论上能用”，请看[验证](/zh-Hans/reference/verification)。

## 这里说的 Go 风格

阻塞操作把 Context 放在第一个参数，资源所有权写清楚，停止后有稳定的终态，小接口靠结构类型实现。它不是把 Go 的大小写、channel 或 goroutine 生搬硬套到 TypeScript；TS 该怎么导出就怎么导出，第三方库独有的语义也继续留在原生对象上。
