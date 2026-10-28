# `@go-like/registry-consul`

基于 Consul HTTP API 与标准 Web `fetch` 实现的 `@go-like/registry` provider。

本包直接实现根 Registry 契约，不引入 Consul 专属的第二套服务模型：

- 注册和注销使用 `ServiceInstance { id, name, version, metadata, endpoints }`；
- `register(ctx, instance)` 与 `deregister(ctx, instance)` 都返回 `Promise<void>`；
- `getService(ctx, name)` 返回不可变的 `ServiceInstance[]`；
- `watch(ctx, name)` 返回只有 `next(ctx)` 与 `stop(ctx)` 的 `Watcher`；
- `next(ctx)` 每次返回完整 replacement snapshot；
- TTL check 与 heartbeat 完全由 provider 私有管理。

## 使用

```ts
import { background } from "@go-like/context"
import { type ServiceInstance } from "@go-like/registry"
import { newConsulRegistry } from "@go-like/registry-consul"

const registry = newConsulRegistry({
  fetch,
  address: "http://127.0.0.1:8500",
  timeoutMs: 5_000,
  ttlMs: 30_000
})

const instance: ServiceInstance = {
  id: "orders-1",
  name: "orders",
  version: "v1",
  metadata: { region: "cn-east" },
  endpoints: ["http://127.0.0.1:8080/"]
}

const watcher = await registry.watch(background(), instance.name)

await registry.register(background(), instance)
const replacement = await watcher.next(background())

await registry.deregister(background(), instance)
await watcher.stop(background())

void replacement
```

第一条 endpoint 会投影到 Consul Agent 的 `Address` 与 `Port`；完整 endpoints、version 和 metadata
以经过校验的 managed payload 保存，因此发现结果仍能无损还原为同一个 `ServiceInstance`。endpoint
沿用根 registry 的绝对 URL 规则；Consul provider 要求第一条 URL 能解析出 host 与 TCP port。

## 注册生命周期

Consul TTL 最小值为 2 秒。`register` 只有在 Agent 接受服务且 TTL check 可续约后才成功；成功后本包在
内部按 TTL 周期续约。再次注册相同 `{ name, id }` 会原子替换同一个确定性 Consul service ID，并替换旧的
私有 heartbeat owner。

调用 `deregister` 会删除该确定性记录并停止私有 heartbeat。网络响应不确定时，本包通过 Agent readback
判断 mutation 是否已经生效。应用无需、也不能管理额外 registration handle。

## 发现与 Watch

`getService(ctx, name)` 读取 `passing=true` 的 Consul health snapshot，仅还原带
`Go-Like-Service-Instance=1` 标记且通过 payload 校验的记录；其他应用注册的 Consul 服务会被忽略。

Watcher 使用 Consul blocking query。已有实例时，第一次 `next(ctx)` 返回当前完整快照；没有实例时，它等待
首次变化。后续每次变化都返回完整 replacement snapshot，注销最后一个实例时返回空数组。单次
`next(ctx)` 的 Context 取消只放弃该次等待，不会停止 resident watcher；资源释放统一使用
`watcher.stop(ctx)`。

## 配置

`newConsulRegistry` 借用应用传入的标准 Fetch capability：

```ts
const registry = newConsulRegistry({
  fetch,
  address: "https://consul.example",
  token: process.env.CONSUL_HTTP_TOKEN,
  datacenter: "dc1",
  namespace: "default",
  waitMs: 300_000,
  minimumQueryIntervalMs: 1_000,
  retryInitialMs: 250,
  retryMaximumMs: 30_000,
  deregisterCriticalServiceAfterMs: 60_000,
  watchBufferSize: 128,
  timeoutMs: 5_000,
  ttlMs: 30_000,
  logger: null
})
```

`address` 必须是单一、无 credentials/path/query/fragment 的 HTTP(S) origin。ACL token 只写入
`X-Consul-Token` header，不进入 URL、错误消息或诊断字段。

`address`、`logger`、`timeoutMs` 与注册租约 `ttlMs` 都只通过 provider constructor 配置，
不通过 Registry 实例暴露可变 `init/options/string` 状态。

## 后台注册终态

构造参数 `onRegistrationError(error, service)` 用于观察已经成功注册、随后因不可重试 TTL heartbeat
错误而失效的 generation。provider 会先撤销该 generation 的本地 active 状态，再以防御性
`ServiceInstance` 快照调用一次回调；可重试错误仍只执行既有 backoff。回调抛错或返回 rejected
thenable 不会替换 heartbeat 错误，也不会阻塞后续 `deregister`。

## 资源所有权

| 资源                  | Owner                      | 契约                                                      |
| --------------------- | -------------------------- | --------------------------------------------------------- |
| `consul-fetch`        | 应用                       | 仅借用；本包不调用 `close`、`destroy` 或同类能力。        |
| `consul-process`      | 应用/运维                  | 仅通过 HTTP 使用；本包不启动、停止或配置 Consul 进程。    |
| private TTL heartbeat | `@go-like/registry-consul` | 由 `register` 创建，由 replacement 或 `deregister` 终止。 |
| Consul Watcher        | `@go-like/registry-consul` | 由 `watch` 创建，由 `watcher.stop(ctx)` 终止。            |

## 验证

```bash
bun run --filter '@go-like/registry-consul' typecheck
bun run --filter '@go-like/registry-consul' test:unit
bun run --filter '@go-like/registry-consul' build
GO_LIKE_E2E_OWNER=local bun run --filter '@go-like/registry-consul' test:e2e
```

Docker 集成使用固定 digest 的真实 Consul，验证 ServiceInstance 注册/发现/注销、replacement
snapshot watcher、私有 TTL heartbeat，以及清理后零残留容器。
