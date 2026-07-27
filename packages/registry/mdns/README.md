# `@likego/registry-mdns`

`@likego/registry-mdns` 是 `@likego/registry` 的 mDNS 实现，适合本地开发、局域网服务发现和不依赖中心注册中心的部署环境。

它沿用统一的 `Registry` 用户模型：

- `register` / `deregister` 注册与注销 `ServiceInstance`；
- `getService` 按服务名查询实例；
- `watch` 返回 `Watcher`，通过 `next` 获取完整服务快照，通过 `stop` 停止监听。

provider 不引入额外的注册句柄、运行器或结果包装类型。注册状态和 UDP socket 均由 provider 内部管理；调用 `deregister` 或 `Watcher.stop` 返回时，对应网络资源已经完成清理。

## Node.js

mDNS 依赖 UDP multicast，而标准 Web API 没有 UDP 接口。portable provider 因此通过 `MDNSHost` 隔离运行时差异；Node.js 后端使用 `@likego/registry-mdns/node` 提供的实现：

```ts
import { background } from "@likego/context"
import { type ServiceInstance } from "@likego/registry"
import { newMDNSRegistry, ttl, watchBufferSize } from "@likego/registry-mdns"
import { newNodeMDNSHost } from "@likego/registry-mdns/node"

const ctx = background()
const registry = newMDNSRegistry(newNodeMDNSHost(), watchBufferSize(32), ttl(120_000))
const service: ServiceInstance = {
  id: "catalog-1",
  name: "catalog",
  version: "v1",
  metadata: { zone: "local" },
  endpoints: ["http://192.168.1.20:8080/"]
}

const watcher = await registry.watch(ctx, service.name)

await registry.register(ctx, service)
const services = await registry.getService(ctx, service.name)
const snapshot = await watcher.next(ctx)

await registry.deregister(ctx, service)
await watcher.stop(ctx)

void services
void snapshot
```

`newNodeMDNSHost()` 本身不分配资源。首次注册、查询或监听时才按选定网卡创建 socket 并加入 multicast group。

## Provider 配置

构造函数接受 Go 风格 functional options：

```ts
import {
  domain,
  families,
  interfaces,
  newMDNSRegistry,
  onRegistrationError,
  queryTimeout,
  ttl,
  watchBufferSize
} from "@likego/registry-mdns"
import { newNodeMDNSHost } from "@likego/registry-mdns/node"

const registry = newMDNSRegistry(
  newNodeMDNSHost(),
  domain("services.local"),
  families("ipv4", "ipv6"),
  interfaces("eth0"),
  queryTimeout(1_000),
  ttl(120_000),
  watchBufferSize(128)
)
```

还可以通过 `port`、`maxPacketBytes` 与 `maxDecodedPayloadBytes` 调整协议边界。mDNS 不使用远端
Registry 地址；查询等待由 constructor 上的 `queryTimeout(...)` 控制，replacement snapshot
队列容量由 `watchBufferSize(...)` 控制，DNS-SD 记录寿命由 provider-local `ttl(...)` 控制。
构造函数不接受根 Registry option，实例也不暴露
可变 `init/options/string` 状态。

可通过 `onRegistrationError((error, service) => { ... })` 观察已成功注册、随后因 socket、receive、response
或 refresh 永久失败而失效的 generation。provider 会先移除 active token/map，再以防御性
`ServiceInstance` 快照通知一次；回调抛错或返回 rejected thenable 不会接管 socket cleanup。该能力保持
mDNS 现有 functional option 风格，不引入第二套构造参数。

每个 endpoint 必须是包含 IP literal 与端口的绝对 URL。同一个 `ServiceInstance` 的 endpoint 必须使用同一端口，且 IP 必须属于已选本地网卡。该限制来自 DNS-SD 的 SRV/A/AAAA 映射，不是额外的业务模型。

## 运行时边界

- 根入口 `@likego/registry-mdns` 不静态导入 `node:` 模块；
- `@likego/registry-mdns/node` 提供 Node.js `node:dgram` host；
- 后续运行时只需实现相同的 `MDNSHost` datagram 边界，不改变应用使用的 `Registry` 接口。

Node.js host 使用 `reuseAddr`，multicast TTL / hop limit 固定为 255，并分别支持 `224.0.0.251:5353` 与 `ff02::fb:5353`。

## 协议与生命周期

- 服务身份固定为 `[name, id]`，同一身份再次 `register` 表示替换当前版本；
- TXT payload 使用 canonical UTF-8 JSON、`deflate+base64url`、SHA-256 Base32 hash 与有界分片；
- wire key 使用 `Likego-` namespace，当前 wire version 为 `2`；
- 正常注销发送 TTL 0 goodbye；进程异常退出后依赖短期记录与缓存过期移除服务；
- 同一身份出现不同内容时 fail closed，不静默合并冲突；
- `watch.next(ctx)` 返回完整替换快照，而不是 provider 私有事件。

## 验证

包级检查使用 Bun workspace：

```sh
bun run --filter @likego/registry-mdns typecheck
bun run --filter @likego/registry-mdns test
bun run --filter @likego/registry-mdns test:coverage
```

真实协议门禁使用 Docker bridge 中的独立 publisher、observer 与 packet capture 容器：

```sh
LIKEGO_E2E_OWNER=likego-registry-mdns bun run --filter @likego/registry-mdns test:docker
```

门禁覆盖 IPv4 / IPv6 注册、发现、更新、恢复、注销、domain 隔离、内容冲突、协作 responder 接管、publisher `SIGKILL` 后 TTL expiry，以及 pcap 中的 multicast TTL / hop limit、RR TTL、cache-flush、owner / target 与 wire version。结束时还会检查 observer 不再接收数据、进程 socket descriptor、`/proc/net/udp*`、容器与 Docker network 清理。
