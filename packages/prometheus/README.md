# @go-like/prometheus

该适配器通过 `@go-like/core/web` 的标准单参数 `Handler`，暴露由应用拥有的
[`prom-client`](https://github.com/prometheus/client_js) `Registry`。

## 所有权

- 应用直接从 `prom-client` 创建 `new Registry()`；go-like 不再包装官方构造函数。
- 应用拥有指标注册、`Registry.clear()` 以及附加到 registry 的每个 collector。
- `createPrometheusHandler()` 非驻留，不创建定时器、监听器或后台服务。
- 该适配器绝不读取或修改 prom-client 全局 registry。

除应用通过 `newPrometheusMeterProvider(registry)` 登记的指标外，应用自行注册的指标名称和 label schema 仍由应用拥有。必须限制 label 值域；
不要把请求 ID、用户 ID、URL 或其他无界值作为 label。原始 Registry 契约有意不假装能在运行时强制
应用控制基数。

## Meter provider

公开入口是 `@go-like/prometheus/metric`。它填充 `MeterProvider`、`Instrument` 与 `TelemetryLifecycle`。
抓取用的 `createPrometheusHandler` 返回 `@go-like/core/web` 的 `Handler`，留在同一入口，这是文档化的命名例外。

## 依赖

`@go-like/core` 的 peer 是锁步精确版本，dev 依赖是 `workspace:*`。`prom-client` 是 peer。本包没有可选 peer，
也没有常规运行时依赖。开发依赖把 `prom-client` 钉在 `15.1.3`。

| 种类 | 包              | 范围      |
| ---- | --------------- | --------- |
| peer | `@go-like/core` | `0.0.1`   |
| peer | `prom-client`   | `^15.1.3` |

- `newPrometheusMeterProvider(registry)` 返回 core `MeterProvider`。它从不读取或修改全局 registry。
  `start` 在资源非空且 registry 还没有 `target_info` 时登记一次 `target_info`，然后立即返回；`stop` 立即返回。
- descriptor 名称里非 `[a-zA-Z0-9_]` 的字符变成 `_`，并追加单位后缀（`s` → `_seconds`，`ms` → `_milliseconds`，`By` → `_bytes`）。
  以 `{` 开头的单位不加后缀；其他未知单位先按同一规则清洗再追加。counter 在名称尚未以 `_total` 结尾时追加 `_total`。
  同名不同类型抛出 `TypeError`。
- `createPrometheusHandler(registry, { path? })` 返回 `@go-like/core/web` 的 `Handler`。默认路径是 `/metrics`。
  GET 与 HEAD 返回 registry 的文本暴露格式，并设置 `Cache-Control: no-store`。

```ts
import { createPrometheusHandler, newPrometheusMeterProvider } from "@go-like/prometheus/metric"
import { Registry } from "prom-client"

const registry = new Registry()
const meters = newPrometheusMeterProvider(registry)
const metrics = createPrometheusHandler(registry)
```

请求完成指标由 `@go-like/core` 的遥测层写入这个 meter provider。operation 采用稳定的低基数名称，
Broker topic、URL、请求 ID 与用户 ID 不进入 label。

v1 适配器有意不封装 `collectDefaultMetrics()`。部分默认 collector 会创建驻留的原生 observer 或事件循环
monitor，而上游辅助函数并未暴露清理 handle。若应用明确愿意拥有该进程级生命周期，可以直接调用官方函数。

## 错误码

本包不定义 `GO_LIKE_` 错误码。非法 registry、非法抓取路径，以及同名指标的类型冲突，都抛出 `TypeError`。

## 运行时验证

运行时检查使用当前环境中可执行的工具，并记录实际观察值；版本号不构成执行或支持门禁。依赖版本继续由 package manifest 与 lockfile 管理。

返回的处理器只依赖标准 Web API，可交给 `@go-like/core/web/node` 或任何接受 go-like `Handler` 的自实现 Server；
该包不依赖 `@go-like/core/web/node`，也不拥有 listener 生命周期。
