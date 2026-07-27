# LikeGo 仓库内部测试工具

本目录只服务仓库内的 provider 一致性测试，不发布到 npm，也不是应用开发者需要学习的公共 API。

内部 `server` 入口验证 Kratos 风格的 `Server.start(ctx)` 会持续运行，直到
`Server.stop(ctx)` 完成；不再暴露或检查自定义 Handle、diagnostics 与 orphan 状态。

```ts
import { test } from "bun:test"
import { serverConformanceCases } from "./src/server"

for (const testCase of serverConformanceCases(newServer)) {
  test(testCase.name, testCase.run)
}
```

内部 `listener` 入口保留底层 runtime listener 的资源释放测试，只供 LikeGo 仓库内 provider 使用。
