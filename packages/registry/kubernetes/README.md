# `@likego/registry-kubernetes`

`@likego/registry-kubernetes` 是基于 Kubernetes `discovery.k8s.io/v1 EndpointSlice` 与标准 Web
Fetch 的 `@likego/registry` provider。它直接使用统一的
`ServiceInstance { id, name, version, metadata, endpoints }`，不引入第二套服务模型、CRD、Kubernetes SDK
或运行时全局 `fetch`。

## 使用

```ts
import { background } from "@likego/context"
import { type ServiceInstance } from "@likego/registry"
import { newKubernetesRegistry } from "@likego/registry-kubernetes"

const registry = newKubernetesRegistry({
  fetch,
  address: "https://127.0.0.1:6443",
  namespace: "orders",
  owner: {
    name: podName,
    uid: podUid
  },
  token: serviceAccountToken,
  timeoutMs: 5_000
})

const instance: ServiceInstance = {
  id: "orders-1",
  name: "orders",
  version: "v1",
  metadata: { region: "east" },
  endpoints: ["https://orders.internal/"]
}

const watcher = await registry.watch(background(), instance.name)

await registry.register(background(), instance)
const replacement = await watcher.next(background())

await registry.deregister(background(), instance)
await watcher.stop(background())

void replacement
```

`register(ctx, instance)` 与 `deregister(ctx, instance)` 返回 `Promise<void>`。一个
`{ name, id }` 对应一个确定性 EndpointSlice；再次注册同一 identity 会用
`metadata.resourceVersion` CAS 替换其完整内容。注销只删除仍与传入实例内容一致的当前记录，因此旧 revision
不会误删更新后的实例，也不会删除已由另一个 Pod owner 接管的相同内容。provider 不向应用暴露
registration TTL。

`owner` 是可选的同 namespace Pod `{ name, uid }`。提供后，每个受管 EndpointSlice 都携带该 Pod 的
`metadata.ownerReferences`；Pod 被删除时，Kubernetes garbage collector 会自动删除这些 EndpointSlice。
Pod name 与 UID 可通过 Downward API 注入。未提供 `owner` 时，provider 适用于集群外控制器，但不会伪造自动过期
语义：应用必须在退出前显式调用 `deregister`。

## Wire

完整、规范化的 `ServiceInstance` 保存在受管 annotation 中，并带有 identity/content hash。读取时 provider
重新规范化实例、重算 hash，并核对 EndpointSlice 名称、labels、annotations、地址投影与
`resourceVersion`；不一致的受管对象 fail closed，其他 controller 的 EndpointSlice 被忽略。

第一条 endpoint URL 会尽量投影到 EndpointSlice 的 IPv4、IPv6 或 FQDN 与 TCP port；HTTP/HTTPS 缺省端口分别为
80/443。无法原生表示的绝对 URL 和空 endpoint 集合使用确定性的保留 FQDN/port 载体，完整 endpoint 仍由 annotation
无损保存。因此 Registry 的协议 URL 不会被 Kubernetes 地址字段反向收窄。

## 查询与 Watcher

`getService(ctx, name)` 返回该名称的完整不可变 replacement snapshot。

`watch(ctx, name)` 先 list 获取一致 `resourceVersion`，再从该 revision 建立 EndpointSlice watch。
ADDED/MODIFIED/DELETED 会触发完整 relist；只有目标服务的逻辑 snapshot 变化时才发布。HTTP 或 stream Status
`410 Gone` 会 fresh relist 后续订；队列满时以 `WatcherOverflowError` fail closed。

Watcher 只公开 `next(ctx)` 与 `stop(ctx)`。单次 `next` 的 Context 取消只放弃该次等待；`stop` 会立即通过
AbortSignal 取消 owner stream，并由传入 Context 限制调用者等待。provider 不增加第二套关闭超时，也不借用调用方
Context 以外的隐藏关闭协议。

## Fetch 与安全边界

构造阶段不访问网络。所有 API 请求均由调用方注入的标准 Fetch 执行，并把 Context、Watcher owner signal 与
operation timeout 组合为 Request `AbortSignal`。bearer token 只进入 `Authorization` header，不进入 URL、错误或诊断字段；
配置 token 时，Fetch rejection graph 会在 provider 边界被替换。非成功 HTTP 错误只公开 operation 与 status。

`address` 只能通过 provider constructor 配置；`watchBufferSize` 也在 constructor 中以默认值 `128`
控制 replacement snapshot 队列。`logger` 与 `timeoutMs` 也只在构造时应用；Registry 实例
不暴露可变 `init/options/string` 状态。

constructor 接受 Registry provider 公共的 `onRegistrationError`，但 Kubernetes Registrar 没有 resident
renewal loop，因此不会伪造后台终态回调；API 失败仍由当前 `register` 或 `deregister` Promise 返回。

## 最小 RBAC

目标 namespace 的 Role 只需：

```yaml
apiGroups: ["discovery.k8s.io"]
resources: ["endpointslices"]
verbs: ["get", "list", "watch", "create", "update", "delete"]
```

## 资源所有权

| 资源                  | Owner                         | 契约                                                            |
| --------------------- | ----------------------------- | --------------------------------------------------------------- |
| `kubernetes-fetch`    | 应用                          | 仅借用；本包不调用 `close`、`destroy` 或同类能力。              |
| Kubernetes Watcher    | `@likego/registry-kubernetes` | 由 `watch` 创建，由 `watcher.stop(ctx)` 通过 AbortSignal 终止。 |
| Managed EndpointSlice | Kubernetes Pod/应用           | 配置 `owner` 时随 Pod GC；否则由应用显式 `deregister`。         |
| Kubernetes API/集群   | 应用/平台                     | 本包只使用 namespaced EndpointSlice API，不管理集群生命周期。   |

## 验证

```sh
bun run --filter '@likego/registry-kubernetes' typecheck
bun run --filter '@likego/registry-kubernetes' test:unit:coverage
bun run --filter '@likego/registry-kubernetes' build
bun run test:e2e:suites -- --suite registry-kubernetes-docker
```

真实协议测试固定使用：

```text
rancher/k3s:v1.36.2-k3s1@sha256:6a47cea22c4b834d4ba72c89d291696b79ebe406251f90b446e4dff03513dd87
```
