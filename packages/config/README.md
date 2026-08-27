# @go-like/config

面向 go-like 应用的可移植、不可变配置能力。公共入口采用 go-kratos Config 的
`load / scan / value / watch / close` 心智，不把 Config 当作 Server。

```ts
import { background } from "@go-like/context"
import { newConfig, objectSource, source } from "@go-like/config"

const config = newConfig(source(objectSource("defaults", { http: { port: 8080 } })))
await config.load(background())

const port = config.value("http.port").load()
await config.close(background())
```

在 go-like App 中，使用与 go-kratos 对应的生命周期 hook 加载和关闭 Config，`server(...)` 只接收真正的
HTTP、Cron、Broker 等 Server：

```ts
import { withoutCancel } from "@go-like/context"
import { newConfig, objectSource, source } from "@go-like/config"
import { afterStop, beforeStart, newApp, server } from "@go-like/core"

const config = newConfig(source(objectSource("defaults", { http: { port: 8080 } })))
const app = newApp(
  beforeStart((ctx) => config.load(ctx)),
  server(httpServer),
  afterStop((ctx) => config.close(withoutCancel(ctx)))
)

await app.run()
```

公开入口按 Go 风格职责平铺在同一个包中：

- `@go-like/config` 提供配置编排、合并、校验与观察。
- `@go-like/config/env` 提供无驻留的环境变量配置源。
- `@go-like/config/file` 提供由调用方注入文件能力的可观测配置源。
- `@go-like/config/node` 提供 Node 文件系统能力，可与 file source 显式组合。
- `@go-like/config/yaml` 提供可移植 YAML 解码器，可与 file source 显式组合。

`ConfigSource.watch` 返回的 watcher 与 Kratos 的 `Watcher` 语义一致，只包含 `next(ctx)` 和 `stop(ctx)`。
一旦 watch 成功完成，watcher 就由 Config 管理；若后续结构接纳失败，Config 会调用
`stop(background())` 回滚，并保留原始接纳失败作为主错误。

## Config、Value 与 Watch

根接口不提供另一套 key 对象或 subscription DSL；resolver 只属于构造期发布流水线：

- `load(ctx)` 一次性加载全部 source、接纳 watcher 并发布首个配置，成功时返回 `void`。
- `scan(ctx, schema)` 使用 Standard Schema 校验或转换完整当前配置。
- `value(key)` 返回一个轻量、可复用的 `Value`；`Value.load()` 同步读取当前不可变值。
- `watch(key, observer)` 观察一个已经存在的 key并返回 `void`；同一个 key 的后一次注册替换前一次 observer。
- `close(ctx)` 停止并等待所有已接纳的 source watcher。

`key` 与 Kratos 一样使用点分字符串，例如 `http.port`。路径只穿过对象，不把数组下标解释为路径；
空 segment、不安全对象键和非法 UTF-16 会被拒绝。尚未加载或路径不存在时，`scan` 和 `watch` 抛出
`ConfigNotFoundError`（`GO_LIKE_CONFIG_NOT_FOUND`），而 `Value.load()` 返回 `null`。

```ts
import { background } from "@go-like/context"
import { newConfig, objectSource, source } from "@go-like/config"

const config = newConfig(source(objectSource("defaults", { http: { port: 8080 } })))
await config.load(background())

const port = config.value("http.port")
const schema = {
  "~standard": {
    version: 1,
    vendor: "application",
    validate(value) {
      return typeof value === "number" ? { value } : { issues: [{ message: "number required" }] }
    }
  }
}

const current = await port.scan(background(), schema)
config.watch("http.port", (key, value) => {
  console.log(key, value.load())
})

await config.close(background())
```

`scan` 不触发 source I/O，只读取调用开始时的当前配置。Go 可以把配置反序列化到调用方传入的目标对象；
TypeScript 的接口在运行时不存在，无法可靠复制这种反射行为，所以 go-like 使用生态通用的 Standard Schema
表达校验与转换。这是语言边界，不是第二套 Config 模型。Standard Schema 允许异步校验，因此 `Config.scan`
和 `Value.scan` 保留独立首参 `Context`，把 Web `AbortSignal` 取消传播到等待边界；同步的 `Value.load()`
与 `watch` 注册不接收无意义的 Context。校验 issues、throw、畸形结果和非法输出统一使用冻结的
`ConfigValidationError`（`GO_LIKE_CONFIG_VALIDATION`）。

构造使用 Go 风格 functional option：

- `source(...sources)` 配置完整、有序的 source 列表；
- `resolver(value)` 按 option 顺序追加一个 post-merge resolver；
- `placeholderResolver()` 创建显式的 `${dotted.key}` 占位符 resolver；
- `schema(value)` 配置完整文档的 Standard Schema；
- `onReloadError(handler)` 观察可恢复的后台重载失败；
- `onTerminalError(handler)` 在初始 load 成功后的第一次不可恢复 watcher 失败上同步通知一次。

发布流水线固定为 `sources -> merge -> resolvers -> schema -> publish`。每个 resolver 都接收独立冻结的
完整配置，其返回值会重新经过配置对象校验、复制和冻结。异步 resolver 使用当前 load 或 reload 的
`Context`；取消后迟到的结果不会发布，后台失败仍保留 last-good 配置并进入 `onReloadError`。
内核会用有上限的指数退避自动重试该次变更；成功或新的 source 事件会重置退避，`close` 会取消待执行重试。

占位符解析必须显式启用，不会读取 `process.env`、`Bun.env`、`Deno.env` 或其他运行时全局。需要环境变量时，
应先通过 `envSource(...)` 把调用方提供的记录合并进配置，再从合并后的根对象解析引用：

```ts
import { newConfig, placeholderResolver, resolver, source } from "@go-like/config"
import { envSource } from "@go-like/config/env"

const config = newConfig(
  source(
    envSource(
      {
        APP_SERVICE__HOST: "api.internal",
        APP_SERVICE__PORT: "8443",
        APP_SERVICE__ENDPOINT: "https://${service.host}:${service.port}"
      },
      { prefix: "APP_" }
    )
  ),
  resolver(placeholderResolver())
)
```

`${dotted.key}` 只接纳字符串引用，`${dotted.key:default}` 的 default 可以包含冒号和嵌套占位符。对象、数组、
数字、布尔值与 `null` 不会被隐式转成字符串；缺失引用、循环引用和畸形语法会以不包含配置值的
`TypeError` 拒绝本轮发布。

`onReloadError` 只处理可恢复的重载轮次失败；它不拥有 watcher，也不改变 last-good 发布。
`onTerminalError` 处理 watcher 已无法继续工作的后台终态：回调在 owner drain 开始前调用一次，并收到与之后
`close(ctx)` 主错误相同的 Error。回调抛错或返回 rejected thenable 会被观察和隔离，不替换 Config 主错误。
初始 load 失败仍直接由 `load(ctx)` 返回。两个 hook 都不会引入第二套生命周期，真实资源终止仍由
`close(ctx)` 加入同一个 owner drain。

应用可以把终态映射到现有 Health readiness，并请求同一个 App stop；Config 本身不依赖 Health：

```ts
import { background } from "@go-like/context"
import { newConfig, onTerminalError, source, type ConfigSource } from "@go-like/config"
import { afterStop, beforeStart, newApp } from "@go-like/core"
import { newProbeRegistry } from "@go-like/health"

let configReady = false
let app: ReturnType<typeof newApp>
declare const runtimeSource: ConfigSource
const probes = newProbeRegistry()
probes.register("ready", "config", () => {
  if (!configReady) throw new Error("configuration is not ready")
})

const config = newConfig(
  source(runtimeSource),
  onTerminalError(() => {
    configReady = false
    void app.stop()
  })
)
app = newApp(
  beforeStart(async (ctx) => {
    await config.load(ctx)
    configReady = true
  }),
  afterStop(() => config.close(background()))
)

await app.run()
```

`watch` 建立静默基线，只在目标值发生语义变化时调用 observer。对象键顺序不影响比较，数组顺序仍然有效；
目标暂时缺失时保留 last-good 基线，恢复为同值不会制造通知。observer 的异常与 rejected thenable 会被隔离，
不会回滚已经完成的配置发布。

## 环境变量配置源

`@go-like/config/env` 把显式提供的环境变量记录转换为不可变的 `@go-like/config` 配置源。它绝不读取
`process.env`、`Bun.env` 或其他运行时全局对象。

```ts
import { envSource } from "@go-like/config/env"

const source = envSource(
  { APP_HTTP__PORT: "8080", APP_HTTP__HOST: "127.0.0.1" },
  { prefix: "APP_" }
)
```

`prefix` 后的 key 按 `separator`（默认为 `__`）拆分，并默认转换为小写。除非显式提供 `decode` 回调，
否则值保持字符串。空路径段、不安全对象 key、规范化后的重复路径，以及标量/对象路径冲突都会在构造时
被拒绝。解码后的组合值会被深度复制并冻结；只接纳普通数据对象和由数据属性组成的稠密数组，因此访问器、
symbol、带附加属性的数组、循环引用和非有限数值都无法越过能力边界。

## 文件配置源

`@go-like/config/file` 把调用方提供的文件系统能力转换为 `@go-like/config` 配置源。生产代码中不包含任何
运行时特定的文件系统 import。

该能力以 `Context` 作为第一个参数，并同时返回文件文本与不透明 revision。可选的 watch 操作会把一个私有
订阅移交给配置源；go-like 合并变更回调，并负责停止已接纳的订阅。默认解码 JSON 对象；自定义 decoder
可以增加 YAML、TOML 或其他格式，而无需修改配置源。

预先取消的操作不会调用运行时能力。若在接纳原生文件 watcher 期间取消变得可观测，配置源会先调用
`stop(background())` 回滚，再以精确的 Context 原因拒绝。文件能力的 `done()` 仅用于适配 Node 等原生
watch API 的被动错误和真实关闭完成状态；它不会出现在 `ConfigSourceWatcher` 或 `Config` 的应用级接口中。
第一次调用配置源 watcher 的 `stop(ctx)` 会启动一次共享关闭；调用方 Context 只限制本次等待，不会撤销
已经开始的资源释放。同步接纳失败会执行同样的回滚；清理失败会聚合，但不会取代主失败。

每次 `next(ctx)` 都会在消费保留的 dirty 通知前检查 Context。因此，预先取消的调用方会收到精确原因，
同时合并后的变更仍留给下一个有效调用方。

```ts
import { fileSource } from "@go-like/config/file"

const source = fileSource(
  {
    async read(ctx, path) {
      return files.read(ctx, path)
    },
    async watch(ctx, path, changed) {
      return files.watch(ctx, path, changed)
    }
  },
  "/etc/application/config.json"
)
```

`files` 是由应用选择的运行时能力。Node、Bun、Deno、虚拟文件系统或测试实现都可以满足同一个结构契约，
且不会把运行时全局对象泄漏到业务代码中。

### Node 文件能力

`@go-like/config/node` 是显式 Node 子路径；可移植根入口及 `@go-like/config/file` 不会加载任何 `node:` 模块。
它以完整文件内容的 SHA-256 作为 revision，并监听目标文件的父目录，因此普通写入和临时文件 rename 覆盖都能
触发同一个 file source。原生 watcher 由返回的文件 watcher 管理：`stop(ctx)` 只让有效调用者启动一次关闭，
`done()` 始终返回同一个真实终止屏障，被动文件系统错误则通过该屏障显式拒绝。

```ts
import { fileSource } from "@go-like/config/file"
import { newNodeFileCapability } from "@go-like/config/node"

const source = fileSource(newNodeFileCapability(), "/etc/application/config.json")
```
