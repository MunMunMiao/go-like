# @likego/registry-zookeeper

`@likego/registry-zookeeper` 是 LikeGo 的 ZooKeeper 注册中心实现。公共用法与
`@likego/registry`、go-kratos 的 `Registrar` / `Discovery` 模型保持一致，不暴露
ZooKeeper 会话、注册句柄或 provider capability 等额外概念。

## 安装

```bash
bun add @likego/registry-zookeeper
```

## 使用

```ts
import { background } from "@likego/context"
import { newZookeeperRegistry } from "@likego/registry-zookeeper"

const registry = newZookeeperRegistry({
  address: "127.0.0.1:2181",
  root: "/likego/registry/v1",
  timeoutMs: 5_000
})

const instance = {
  id: "catalog-1",
  name: "catalog",
  version: "v1",
  metadata: { zone: "cn-east-1" },
  endpoints: ["http://127.0.0.1:8080/"]
}

await registry.register(background(), instance)

const services = await registry.getService(background(), "catalog")
const watcher = await registry.watch(background(), "catalog")

await registry.register(background(), {
  ...instance,
  endpoints: ["http://127.0.0.1:8081/"]
})
const replacement = await watcher.next(background())

await registry.deregister(background(), instance)
await watcher.stop(background())
```

`Watcher.next()` 返回某个服务名的完整 replacement snapshot，而不是 ZooKeeper 原始事件。
首次调用在当前快照非空时直接返回当前快照；后续注册、更新和注销均返回新的完整快照。

## ZooKeeper 映射

- 实例路径固定为 `<root>/services/<service-name>/<instance-id>`，服务名和实例 ID 使用
  UTF-8 Base64URL znode segment 编码。
- 实例 znode 为 ephemeral 节点；其会话由本包私有持有，`register()` 只返回 `void`。
- 同一 `name + id` 再次注册会替换原 znode，与 go-kratos ZooKeeper 实现的身份和更新语义一致。
- `deregister()` 删除同一确定性路径；最后一个本地实例注销后，本包关闭注册会话。
- ZooKeeper child watch 是 one-shot；本包会自动重新挂载，并用周期 reconcile 补偿断线窗口。
- session expiration 后，本包创建新会话并恢复当前仍登记的实例。
- ZooKeeper ephemeral 生命周期由原生 session timeout 控制，不向应用暴露 registration TTL。

## ACL 与认证

默认使用 ZooKeeper `OPEN_ACL_UNSAFE`。如需 digest auth 和 creator ACL：

```ts
const registry = newZookeeperRegistry({
  address: "127.0.0.1:2181",
  auth: { scheme: "digest", credential: "application:password" },
  acl: "creator"
})
```

credential 仅进入私有客户端快照，不进入公共 Registry 契约、错误或日志字段。

`address` 与可选的 `watchBufferSize` 只通过 `newZookeeperRegistry` 的 provider constructor
配置；`logger` 与 `timeoutMs` 也只在构造时应用。Registry
实例不暴露可变 `init/options/string` 状态。

`onRegistrationError(error, service)` 观察 registration session 的不可恢复 recovery 或 authentication
终态。一个 session 终止时，provider 先使其中所有 active generation 失效，再为每个实例以防御性快照
通知一次；可重试 recovery 继续沿用既有 backoff。回调失败被观察并隔离，不接管 session 清理或后续注销。

## 生命周期与所有权

| 资源                             | 所有者    | 生命周期                                        |
| -------------------------------- | --------- | ----------------------------------------------- |
| `zookeeper-registration-session` | LikeGo    | 首次注册时建立；最后一个实例注销后关闭。        |
| `zookeeper-watcher-session`      | LikeGo    | `watch()` 建立；`Watcher.stop()` 后关闭。       |
| `zookeeper-process`              | 应用/运维 | 本包只连接，不启动、停止或配置 ZooKeeper 进程。 |

`node-zookeeper-client` 的官方 `close()` API 不接受 `AbortSignal` 或 callback；本包会立即请求
原生关闭并等待连接状态收敛，调用
`Watcher.stop(ctx)` 的 Context 只控制该调用者是否继续等待，不会把基础设施细节提升为新的公共概念。

## 运行时边界

- 支持 Node.js 与 Bun 后端。
- 不支持浏览器和 Deno。
- 当前真实 E2E 使用官方 `zookeeper:3.9.5` 镜像，覆盖注册、查询、更新、
  replacement watch、注销、SIGKILL 后 ephemeral 过期以及资源清理回读。
