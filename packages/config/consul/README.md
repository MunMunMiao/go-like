# @likego/config-consul

`@likego/config-consul` 从精确的 Consul KV key 加载一个 JSON 配置对象，并通过 Consul HTTP 阻塞查询
持续监视该对象。它只使用标准 `Request`、`Response`、`Headers`、`AbortSignal`，以及调用方提供的
单参数 Fetch 函数；不依赖 Consul SDK 或 gRPC。

```ts
import { consulSource } from "@likego/config-consul"

const source = consulSource({
  fetch(request) {
    return fetch(request)
  },
  address: "http://127.0.0.1:8500",
  key: "applications/orders/config",
  token: credentials.consulToken
})
```

watcher 遵循 HashiCorp 的索引规则：忽略内容未变化的超时响应；把零限制为一以防止忙循环；索引回退时，
先重置阻塞游标再投递变更。按照 HashiCorp 建议，对立即出现的未变化/重置循环进行限速（默认一秒）。
传输失败以及 HTTP 404、408、425、429 和 5xx 响应采用感知 Context、设有上限的指数重试（默认从
250 毫秒到 30 秒）；Consul 不可用期间保留最后一个有效配置。认证错误和其他不可重试客户端错误属于
终止错误。中断后的第一次成功响应会强制执行一次协调，即使重启后的 Consul 报告相同数值索引；这样既
弥合观测缺口，也不会假装一个不透明索引足以证明失败传输前后的连续性。token 只通过
`X-Consul-Token` 发送；重定向会被拒绝，公共错误中绝不包含 token。

Fetch 与成功响应体的消费共同构成一个传输状态机边界：如果 200 响应的 body 读取失败，则按传输失败重试。
对于非成功响应，即使取消 body 时发生拒绝或永不结束，HTTP 状态仍具有判定权；取消只以非阻塞的尽力方式
启动，因此损坏的 503 body 无法压制重试分类。请求 Context 的取消仍以其精确原因为最终结果，包括调用方
提供的 Fetch 返回不配合取消的成功响应体时。

配置源在构造时拒绝精确为 `.` 和 `..` 的 key 路径段。WHATWG URL 解析会在 Fetch 发送请求前规范化这些
路径段；若允许它们，就会悄悄访问另一个 Consul key。其他路径段会进行百分号编码，同时保留斜杠层级。

官方参考资料：

- https://developer.hashicorp.com/consul/api-docs/kv
- https://developer.hashicorp.com/consul/api-docs/features/blocking
- https://releases.hashicorp.com/consul/（2026-07-18 核验的最新稳定版：2.0.2）
- https://fetch.spec.whatwg.org/（标准 `Request`、`Response` 与请求 signal）
- https://dom.spec.whatwg.org/#aborting-ongoing-activities（`AbortController` 与 `AbortSignal.any`）
- https://www.typescriptlang.org/tsconfig/lib.html（TypeScript 标准 API 声明库）
