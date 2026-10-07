# `@go-like/struct`

`@go-like/struct` 为 LikeGo 服务契约提供可移植的运行时结构。一个声明同时提供 TypeScript 推导类型、运行时校验和 JSON wire 编解码元数据。

```ts
import { struct, type Infer } from "@go-like/struct"
import { decodeJson, encodeJson } from "@go-like/struct/codec"

const User = struct.object({
  id: struct.string(),
  name: struct.string().alias("user_name"),
  active: struct.boolean()
})

type User = Infer<typeof User>

const [error, value] = struct.parse(User, {
  id: "u_1",
  name: "Ada",
  active: true
})

const wire = encodeJson(User, value)
const decoded = decodeJson(User, wire)
```

## 入口

- `@go-like/struct`：`struct`、`StructError`、`Infer`、`StructInput`、`ParseResult`、`ObjectStruct`、`StructLike`。
- `@go-like/struct/codec`：`encodeJson`、`decodeJson`。
- `@go-like/struct/runtime`：`isStruct`、`isObjectStruct`、`getStructFields`、`parseStructTuple`、`parseStructValue`、`encodeStructValue`。

## 严格解析

`struct.parse(schema, input, options?)` 返回 `[error, value]`。成功是 `[null, value]`，失败是 `[StructError, undefined]`。解析在第一个问题处停止，不返回部分结果。

| 修饰符                    | 字段缺失      | 值为 `null`   |
| ------------------------- | ------------- | ------------- |
| 无                        | `StructError` | `StructError` |
| `.optional()`             | 省略该键      | `StructError` |
| `.null()` / `.nullable()` | `StructError` | 保留 `null`   |
| `.nullish()`              | 省略该键      | 保留 `null`   |

缺失必填字段时，`StructError` 写明字段路径，并提示：`Use optional() or nullish() if the field may be omitted`。

- 未声明的 object 字段会被丢弃。输出对象使用 `null` prototype。
- `alias(name)` 只改变 wire key。`struct.parse` 默认按 TypeScript 属性名读取；`{ aliases: true }` 和 `decodeJson` 按 `alias ?? key` 精确读取。空字符串 alias 就是空 wire key，不会回退到属性名。输出属性始终是 TypeScript 属性名。
- 大小写或 Unicode 折叠不会匹配字段。
- 同一 object shape 的 wire key 必须唯一。静态字段在 `struct.object(...)` 定义时抛 `TypeError`；getter 字段在第一次解析时抛 `TypeError`。
- `errorMap` 只作用于这一次解析及其嵌套字段。没有全局 `setErrorMap`。
- `decodeJson` 按 schema 返回 `Infer<S>`。

```ts
const [error, user] = struct.parse(User, wireValue, {
  aliases: true,
  errorMap: (issue) => `字段 ${issue.path.join(".")} 无效`
})
```

公开错误信息不会保留字符串或对象原文，只保留 `null`、`undefined`、布尔值和数字。

递归 object 可以用 getter 延迟引用自身：

```ts
type Category = { children: Category[]; id: string }

const Category = struct.object({
  get children() {
    return struct.array(Category)
  },
  id: struct.string()
})
```

安全预扫描只遍历数据属性，不触发 getter。循环 value graph，以及超过 1000 层容器嵌套的值，会被拒绝，而不是抛出 `RangeError`。

容器嵌套上限是 1000 层。`parse`、`decodeJson`、`encodeJson`、`encodeStructValue`、`decodeJsonBody`、`encodeJsonBody` 遇到更深的值时，失败信息包含 `depth limit 1000`。`parse` 把它放进返回值里的 `StructError`，`encodeJsonBody` 抛出 `StructError`，其余入口抛出 `TypeError`。递归组合 schema（嵌套 `or` / `discriminatedUnion`，以及它们与 object、array、tuple、record、intersection 的组合）在默认调用栈上的可达层数，用独立冷进程测量：不设置 `NODE_OPTIONS`，不传 `--stack-size`，每个进程只处理一份 1000 层合法值。2026-09-30 的结果是 Bun 1.4.2、Node 26.10.0、Deno 2.9.7 上上述入口均能完成 1000 层；1001 层由容器上限拒绝。这组 schema 的限制是容器上限，不是默认调用栈。用户 getter 等路径如果仍然耗尽调用栈，公开入口把真实栈耗尽异常转成 `StructError`，信息为 `struct recursion exceeded the supported call stack depth`。判定不使用 `instanceof`：`Object.prototype.toString` 为 `[object Error]`，且 `name` 与 `message` 精确等于引擎文案。2026-09-30 实测 V8（Node 26.10.0、Deno 2.9.7）为 `Maximum call stack size exceeded`，JavaScriptCore（Bun 1.4.2）为 `Maximum call stack size exceeded.`；SpiderMonkey 的 `too much recursion` 同时接受 `RangeError` 与 `InternalError`。消息只是包含这些片段的其他异常原样抛出。手工构造且与上述文案完全相同的异常无法与真实耗尽区分，也会被转成 `StructError`。

本包迁移自 Zen Kit `packages/core/src/struct`，保留 MIT 许可证。HTTP request/body struct、Go Unicode fold、dominant-field 选择和重复 wire key 合并不属于本契约。
