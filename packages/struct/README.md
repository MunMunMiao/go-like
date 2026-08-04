# `@go-like/struct`

`@go-like/struct` 为 go-like 服务契约提供可移植的 Go-style runtime struct。字段声明同时产生 TypeScript
输出类型和运行时编解码元数据；go-like Transport 直接使用这一份契约，不需要 Proto 或生成代码。

```ts
import { struct, type Infer } from "@go-like/struct"

const User = struct.object({
  id: struct.string(),
  name: struct.string().alias("user_name"),
  active: struct.boolean()
})

type User = Infer<typeof User>
```

服务契约只需要根入口。Transport 等边界实现使用 `@go-like/struct/codec` 完成 JSON wire 编解码，或使用
`@go-like/struct/runtime` 调用 `isStruct`、`parseStructTuple`、`parseStructValue` 与 `encodeStructValue`；内部实现文件不属于
公共入口。

## Go 兼容基线

行为基线是 [Go 1.26 `encoding/json` v1](https://github.com/golang/go/tree/go1.26.5/src/encoding/json)。Go
1.26 的 `encoding/json/v2` 仍是实验功能，不作为生产兼容承诺。

对齐的主要可观察行为包括：未知 object 字段默认忽略、缺失或非 nullable 标量 `null` 使用零值、JSON 字段
exact match 优先并回退到 Go Unicode simple fold、重复匹配字段按输入顺序解码（object 递归合并、array/tuple
复合元素按索引合并、record 同 key value 整体替换、标量由后值覆盖），以及 record 的非 array-index string key
编码按 UTF-8 byte 顺序排序。

以下是宿主模型决定的必要差异：

- `decodeJson` 接收的已经是 JavaScript value；原始 JSON 的完全相同 key 已由上游 parser 处理，因此只有仍可见的
  不同 own key（包括大小写折叠后匹配同一字段的 key）能够按顺序解码。JavaScript array 也没有 Go slice 的
  capacity，因此不会复现已移出当前数组长度的旧元素被后续解码再次复用。
- Go `Unmarshal` 可以同时返回错误和已经部分更新的目标值；`decodeJson` 是 all-or-throw API，遇到任一字段错误时
  抛出 `StructError`，不返回部分结果。
- `decodeJsonBody` 使用标准 `JSON.parse`；`1`、`1.0` 与 `1e0` 按 JavaScript 语义表示为同一个 number，不承诺
  保留 Go integer decoder 对原始 number 拼写的区分。
- `number()` 除 `NaN` 外沿用 JavaScript number 语义；JSON wire 继续使用原生 `JSON.stringify`，因此
  `Infinity`/`-Infinity` 编码为 `null`，`-0` 编码为 `0`。
- `bigint()` 对 string 输入直接使用原生 `BigInt()` 转换，因此空字符串、空白、进制前缀和正号均遵循
  JavaScript 规则；wire 统一编码为十进制 string。
- `date()` 对 number/string 输入直接使用原生 `new Date()` 转换并编码为 ISO string；不含时区的 date-time
  string 按运行进程的本地时区解释，只有日期的 ISO string 与带 `Z`/offset 的 string 不依赖本地时区。
- Go 的 nil map/slice 编码为 `null`；Struct 将缺失容器映射为强类型空 `{}`/`[]`，重新编码仍是空容器。
- JavaScript object 与 `JSON.stringify` 会按数值顺序枚举 array-index string key；例如 `"2"` 在 `"10"` 前，
  无法复现 Go map key 的 UTF-8 byte 顺序 `"10"`、`"2"`。
- Bun、Node.js、Deno 的共同安全深度上限为 1000 层；Go JSON scanner 的上限为 10000 层。超过上限或遇到循环
  value graph 时，Struct 会受控拒绝而不是暴露 `RangeError`。

## Struct 语义

- 缺失或 `null` 的非 optional value field 使用对应零值；例如 string 为 `""`、number 为 `0`、boolean
  为 `false`、array 为 `[]`。
- `optional()` 允许字段缺失，`null()` 使用 `null`，`nullish()` 同时允许缺失和 `null`。
- Object 解码只保留声明字段并丢弃未知字段；输出对象使用 null prototype，避免原型污染。
- `alias(name)` 只改变 wire key，不改变输出属性名或推导类型；`alias("")` 与 Go `json:""` 一致，回退到
  natural field name，并不创建空 key。
- 同层字段按 Go 的 dominant-field 规则处理：一个 non-empty alias 与同名 natural key 冲突时 alias 胜出；两个
  字段使用相同 non-empty alias 时均从 wire 表示中排除，不抛 duplicate-key 错误，decode 后按既有缺失值规则取值。
- 递归 object 使用 getter 延迟解析字段，不需要额外 recursive constructor。

```ts
type Category = {
  children: Category[]
  id: string
}

const Category = struct.object({
  get children() {
    return struct.array(Category)
  },
  id: struct.string()
})
```

该实现迁移自 Zen Kit `packages/core/src/struct`，保留原 MIT 许可证与行为测试。生产代码只依赖标准
ECMAScript 和 Web API。
