# `@go-like/metadata`

`@go-like/metadata` 提供可移植、不可变的多值请求 metadata，以及相互隔离的 client/server Context 域。
所有 key 在写入时归一为小写；value 保持声明顺序。`clone`、`append`、`set`、`remove`、`merge` 均返回新快照，
不会保留调用方对象或数组。公共包不把 metadata 预设成 HTTP header。

```ts
import { background } from "@go-like/context"
import { appendToClientContext, fromClientContext, newMetadata, values } from "@go-like/metadata"

const initial = newMetadata({ "Trace-ID": "trace-1", baggage: ["a=1", "b=2"] })
const ctx = appendToClientContext(background(), "Trace-ID", "trace-2", "tenant", "storefront")

values(fromClientContext(ctx) ?? initial, "TRACE-ID") // ["trace-2"]
```

`set(base, key, value)` 用一个值替换 key，`remove(base, key)` 删除 key。`merge(base, patch)` 采用显式覆盖语义：
patch 中同名 key 的完整多值数组替换 base，对其他 key 不做修改；`append` 才会追加同名 key 的值。
`appendToClientContext` 与 `mergeToClientContext` 对齐 Kratos 的 Context helper。client/server 两个 Context 域
不会互相泄漏，派生 Context 仍保留原 Context 的 deadline、cancel、cause 和普通 value。

## 下游传播

`propagateToClientContext(ctx, options?)` 只从当前 server metadata 复制显式选中的 key：

```ts
import { propagateToClientContext } from "@go-like/metadata"

const downstream = propagateToClientContext(ctx, {
  exact: ["trace-id"],
  prefix: ["x-baggage-"]
})
```

`exact` 与 `prefix` 规则统一按小写匹配，并保留匹配 key 的完整有序多值。已有 client metadata 在同名冲突时
优先，未匹配、仅发生冲突或未配置规则时直接返回原 Context。默认不传播任何 key，避免把 authorization、
cookie 等 server metadata 意外带给下游；空 prefix 和其他非法规则会立即被拒绝。

## 公共边界

- key 只要求是非空 well-formed string，并统一转成小写；
- value 只要求是 well-formed string；公共层不限制 key/value 数量或字节长度；
- 多值数组可以为空，但必须稠密且只含字符串数据项；
- 输入只接受普通对象或 null-prototype 对象，不执行 getter，不接受 symbol key。

控制字符、非 HTTP-token key、单项或总 payload 大小等协议规则由具体 provider 在 wire 边界负责。该包不自动进行
wire 编码。当前 `@go-like/transport` 的 `Message.header` 是单值
`Readonly<Record<string, string>>`，因此 provider 必须为具体协议显式定义多值投影；公共层不会用逗号拼接、覆盖
或 JSON 编码来伪造无损传播。
