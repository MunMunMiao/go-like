# @likego/prometheus

该适配器通过 `@likego/web` 的标准单参数 `Handler`，暴露由应用拥有的
[`prom-client`](https://github.com/prometheus/client_js) `Registry`。

## 所有权

- 应用直接从 `prom-client` 创建 `new Registry()`；LikeGo 不再包装官方构造函数。
- 应用拥有指标注册、`Registry.clear()` 以及附加到 registry 的每个 collector。
- `createPrometheusHandler()` 非驻留，不创建定时器、监听器或后台服务。
- 该适配器绝不读取或修改 prom-client 全局 registry。

除下述固定请求指标外，应用自行注册的指标名称和 label schema 仍由应用拥有。必须限制 label 值域；
不要把请求 ID、用户 ID、URL 或其他无界值作为 label。原始 Registry 契约有意不假装能在运行时强制
应用控制基数。

## 请求指标

`newRequestMetrics(registry)` 创建两个固定 collector：

- `likego_requests_total`
- `likego_request_duration_seconds`

它们只有 `component`、`operation`、`outcome` 三个 label。`outcome` 只会是 `success`、`failure`
或 `canceled`。包装器不会读取或记录 body、header、错误消息、URL、请求 ID 或用户 ID。

```ts
import {
  measureBroker,
  measureClient,
  measureUnaryMiddleware,
  measureWebHandler,
  newRequestMetrics
} from "@likego/prometheus"
import { Registry } from "prom-client"

const registry = new Registry()
const metrics = newRequestMetrics(registry)

const client = measureClient(applicationClient, metrics)
const unary = measureUnaryMiddleware(metrics)
const web = measureWebHandler(applicationWebHandler, metrics)
const broker = measureBroker(applicationBroker, metrics)
```

operation 采用稳定的低基数名称：

- Client 与内部 Server：`service/endpoint`。
- Web：仅 HTTP method，不包含 URL。
- Broker：仅 `publish` 或 `consume`。

Broker topic 不进入 label；动态 subject 不会按消息、订单或租户放大时间序列。Client 按逻辑 call 计量一次，
不因内部 retry 重复计数。Web 在 Response header 可用时完成计量；服务端 `5xx` 记为 `failure`，其他
Response 记为 `success`，请求取消优先记为 `canceled`。

v1 适配器有意不封装 `collectDefaultMetrics()`。部分默认 collector 会创建驻留的原生 observer 或事件循环
monitor，而上游辅助函数并未暴露清理 handle。若应用明确愿意拥有该进程级生命周期，可以直接调用官方函数。

## 运行时矩阵

- Bun 1.3.14
- Node.js 24.18.0 LTS
- Node.js 26.5.0 当前版
- prom-client 15.1.3

返回的处理器只依赖标准 Web API，可交给 `@likego/web/node` 或任何接受 LikeGo `Handler` 的自实现 Server；
该包不依赖 `@likego/web/node`，也不拥有 listener 生命周期。
