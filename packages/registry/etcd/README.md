# `@go-like/registry-etcd`

`@go-like/registry-etcd` 是 `@go-like/registry` 的 etcd 实现。公共 API 与其他 Registry provider
保持一致，只使用 `ServiceInstance`、`register/deregister`、`getService` 和按服务名创建的
replacement snapshot `Watcher`。etcd lease、revision、transaction 与 watch stream 都是包内实现细节。

本包只通过调用方注入的标准 Web `Fetch` 调用 etcd v3 JSON gateway，不依赖 gRPC、Proto runtime、
Node.js SDK 或运行时全局 `fetch`。

## 使用

```ts
import { background } from "@go-like/context"
import { newEtcdRegistry } from "@go-like/registry-etcd"

const registry = newEtcdRegistry({
  fetch,
  address: "http://127.0.0.1:2379",
  timeoutMs: 5_000,
  ttlMs: 10_000
})

const orders = {
  id: "orders-1",
  name: "orders",
  version: "v1",
  metadata: { region: "east" },
  endpoints: ["http://127.0.0.1:8080/"]
}

const watcher = await registry.watch(background(), orders.name)
await registry.register(background(), orders)

const snapshot = await watcher.next(background())
const services = await registry.getService(background(), orders.name)

await registry.deregister(background(), orders)
await watcher.stop(background())
```

`register` 成功后返回 `void`。provider 在内部持有并续约 lease；调用方通过相同的
`deregister(ctx, instance)` 契约移除实例，不需要理解或保存 provider-specific handle。

## 构造选项

| 选项              | 默认值                  | 规则                                                                   |
| ----------------- | ----------------------- | ---------------------------------------------------------------------- |
| `fetch`           | 必填                    | 借用的标准 `(RequestInfo \| URL, RequestInit?) => Promise<Response>`。 |
| `address`         | 必填                    | 单个无 credential、path、query、fragment 的 HTTP(S) origin。           |
| `prefix`          | `/go-like/registry/v1/` | 以 `/` 开始和结束的绝对 UTF-8 key prefix。                             |
| `token`           | 省略                    | 非空 HTTP `Authorization` header 值；不会进入 URL 或诊断。             |
| `retryInitialMs`  | `250`                   | availability retry 初始间隔，整数 `1..60000`。                         |
| `retryMaximumMs`  | `30000`                 | availability retry 上限，整数 `retryInitialMs..600000`。               |
| `watchBufferSize` | `128`                   | replacement snapshot 队列容量，整数 `1..4096`。                        |
| `timeoutMs`       | `5000`                  | 单次 provider 操作超时，整数 `1..60000`。                              |
| `ttlMs`           | `120000`                | 注册 lease 生命周期，整数 `2000..86400000`。                           |
| `logger`          | `null`                  | 借用的结构化 provider 日志接口。                                       |

`address`、`logger`、`timeoutMs` 与 `ttlMs` 只通过 provider constructor 配置。
Registry 实例不暴露可变 `init/options/string` 状态。TLS trust、client certificate、proxy 和连接池属于
注入 `Fetch` 的应用 owner。

## 数据模型与原子更新

每个 `ServiceInstance` 使用由 `name + id` 计算的确定性 key：

```text
<prefix>records/<instance identity hash>
```

value 是包含 wire marker、identity hash、完整内容 hash 和规范化 `ServiceInstance` 的 JSON tuple。
读取时会重新计算 key 与 hash；非法 Base64、UTF-8、JSON、schema、hash 或超过 1 MiB 的 payload
都会 fail closed。

每次 `register` 为实例申请独立 lease，并通过一个 etcd transaction 把完整记录写入确定性 key。
更新同一实例只产生一个新 revision，查询和 Watcher 不会看到拆分状态。响应丢失时，只有独立 range
证明 key、value 与 lease 全部精确匹配，注册才会视为成功。

`deregister` 使用 value compare 后删除，避免本地过期 owner 删除其他 publisher 已写入的新内容。
更新后的旧 lease 会在后台撤销；lease 已经不再绑定 key，因此撤销不会删除新 generation。

## Lease 与故障恢复

Provider TTL 范围为 `2000..86400000ms`，续约间隔为 `floor(ttlMs / 2)`。provider 会同时验证 lease
仍然存在且确定性 key 仍由该 lease 持有。lease 失效且 key 为空时，provider 申请新 lease 并用
create compare 恢复记录；若其他 publisher 已经占用同一 identity，则不会覆盖对方。

transport、408、425、429 与 5xx 使用有界退避；401/403 和协议损坏不会伪装成可重试成功。
进程被终止后不再续约，etcd 会在 TTL 到期后删除 key。

`onRegistrationError(error, service)` 用于观察已经成功注册、随后永久失去 lease 或 key ownership 的
generation。provider 先撤销本地 active 状态，再以防御性 `ServiceInstance` 快照通知一次；可重试
keepalive 错误继续使用既有 backoff。回调抛错或返回 rejected thenable 会被观察并隔离，不改变
`deregister` 与 lease 清理语义。

## 查询与 Watcher

`getService` 对受管 prefix 做 linearizable range，完整验证后返回指定服务的不可变
`ServiceInstance` 快照。

Watcher 先读取一致快照，再从 `revision + 1` 建立 prefix watch，因此初始 range 与后续事件之间
没有丢失窗口。PUT/DELETE 触发完整 relist；compaction 触发 fresh range 后继续监听。`next(ctx)`
返回指定服务的完整 replacement snapshot，而不是 etcd event、revision 或 create/update/delete
动作。空初始快照不会立即返回；首次非空状态、后续更新以及变为空数组都会被发布。

单次 `next(ctx)` 的 Context 取消只放弃该次等待。`stop(ctx)` 中止 watch stream 和 retry timer，
并等待标准 Fetch 响应 `AbortSignal`；调用方可以用该 Context 控制自己的等待边界。

## 所有权

| 资源                | owner     | stop 契约                                                |
| ------------------- | --------- | -------------------------------------------------------- |
| `etcd-registration` | go-like   | `deregister(ctx, instance)` 停止续约并删除本地受管记录。 |
| `etcd-watcher`      | go-like   | `watcher.stop(ctx)` 中止 stream、retry 和 pending wait。 |
| `etcd-fetch`        | 应用      | 仅借用；本包不调用 `close`、`destroy` 或同类能力。       |
| `etcd-process`      | 应用/运维 | 仅通过 HTTP 使用；本包不启动、停止或配置 etcd 进程。     |

## Error 与凭据边界

- `EtcdHttpError` 只暴露 operation 与 HTTP status，不读取非成功 body。
- `EtcdTransportError` 在配置 token 时替换 Fetch rejection graph，避免 Request/header 泄密。
- registry protocol 与 watcher overflow/stopped 复用 `@go-like/registry` 的稳定错误契约。
- token 不进入 URL、message、options snapshot 或日志。

## 验证

```sh
bun run --filter @go-like/registry-etcd typecheck
bun run --filter @go-like/registry-etcd test:unit
bun run --filter @go-like/registry-etcd build
GO_LIKE_E2E_OWNER=local bun run --filter @go-like/registry-etcd test:e2e
```

真实协议测试使用：

```text
gcr.io/etcd-development/etcd:v3.7.1@sha256:a9983dd6d9283138ab926daa307c6c25623636703ecf5645d5df4d666ce9eba2
```

测试覆盖 register/get/list、replacement watch 的新增/更新/删除、丢失 transaction 响应的精确
readback、publisher 被 `SIGKILL` 后 lease expiry，以及测试容器零残留。
