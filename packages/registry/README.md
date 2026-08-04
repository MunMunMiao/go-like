# @go-like/registry

`@go-like/registry` 定义 go-like 的服务注册、发现、Watcher 与 Selector 公共契约。注册对象直接采用
go-kratos 的 `ServiceInstance` 心智：

```ts
interface ServiceInstance {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly metadata: Readonly<Record<string, string>>
  readonly endpoints: readonly string[]
}
```

项目不支持 Protobuf/IDL，因此不再暴露 go-micro 的 `Service/Node/Endpoint/Value` 描述树，也不使用
`RegistrationHandle`、`done()` 或额外的 registration Server。App 通过 Registrar 的 `register` /
`deregister` 直接持有注册生命周期。

## Registry

```ts
import { background } from "@go-like/context"
import type { Registry, ServiceInstance } from "@go-like/registry"

declare const registry: Registry

const service: ServiceInstance = {
  id: "catalog-1",
  name: "catalog",
  version: "v1",
  metadata: { zone: "a" },
  endpoints: ["http://127.0.0.1:9000"]
}

await registry.register(background(), service)
const instances = await registry.getService(background(), "catalog")
await registry.deregister(background(), service)
```

同一服务实例由 `name + id` 唯一标识；`version`、`metadata` 与 `endpoints` 是可原子更新的属性。
公共 Registry 对齐 Kratos 的 Registrar/Discovery 使用面，不暴露 go-micro 的可变
`init/options/string` 方法；provider 配置在各自构造函数中一次性捕获。

`watch(ctx, name)` 返回 Kratos 风格 Watcher。`next(ctx)` 交付完整 replacement snapshot；`stop(ctx)`
结束 watcher。Watcher 不再暴露第二个 terminal Promise，provider 的被动故障由 `next(ctx)` 原样返回。

```ts
const watcher = await registry.watch(background(), "catalog")
try {
  const replacement = await watcher.next(background())
  console.log(replacement)
} finally {
  await watcher.stop(background())
}
```

具体 provider 位于五个独立子 workspace：

- `@go-like/registry-consul`
- `@go-like/registry-mdns`
- `@go-like/registry-etcd`
- `@go-like/registry-kubernetes`
- `@go-like/registry-zookeeper`

五个 provider 在 workspace 内复用同一组 provider-neutral conformance cases；这些测试资产不属于
`@go-like/registry` 的发布 API。

Provider 作者可以从 `@go-like/registry/provider` 导入 `providerOptions`、`notifyRegistrationError` 与不可变
`ServiceInstance` snapshot helper。`ProviderOptionInput.onRegistrationError` 只观察已经成功注册、随后永久丢失的
resident registration generation；回调收到防御性快照，其抛错或 rejected thenable 不会接管 provider 生命周期。
这些实现辅助能力不在应用侧根入口中，避免普通用户接触 provider 配置和内部防御性复制概念。

## Selector

`newRandomSelector`、`newRoundRobinSelector`、`newWeightedRoundRobinSelector`、`newP2CSelector` 与
`newEWMASelector` 直接消费完整 `ServiceInstance[]`。其中 `newEWMASelector` 对齐 Kratos v3 的
P2C + EWMA 决策；选择结果包含实际 URL 与同步 feedback 回调。

`SelectionOutcome` 对齐 Kratos `DoneInfo`：`error` 保持兼容，另可报告不可变的
`replyMetadata`、`bytesSent` 与 `bytesReceived`。内置 selector 只按 `error` 更新健康度，
其余字段供自定义 selector 观测。

`filterVersion(version)` 与 `filterLabel(key, value)` 对齐 go-micro Selector 的常用 Filter
词汇，可先过滤实例再交给 Selector：

```ts
import { background } from "@go-like/context"
import { filterLabel, filterVersion } from "@go-like/registry"

const candidates = filterLabel("zone", "a")(filterVersion("v1")(instances))
const selected = selector.select(background(), candidates)
```

go-like 不提供 `filterEndpoint`。`endpoints` 是 Kratos 风格实例属性，不是 go-micro
`Endpoint` 描述树；调用协议和路径应由 client/transport 决定。
