# @go-like/store-memory

go-like 的进程内 Store provider。每个实例拥有独立 `Map`，构造后即可使用，不创建 timer、
socket 或其他常驻资源。

该 provider 支持 CRUD、毫秒 TTL、`ifAbsent()`、compare-and-swap、Unicode code-point 排序和
revision-bound cursor。TTL 在下一次操作时惰性清理；cursor 仅绑定当前实例的 revision、
prefix 与 offset，实例发生 mutation 后旧 cursor 会 fail closed。

`ifAbsent()` 与 revision CAS 都在单次同步 Map mutation 内判断和提交；并发调用同一 key 时只会有一个
create 成功，其余返回 `GO_LIKE_STORE_CONFLICT`。

`clock` functional option 用于注入确定性时钟；未指定时使用标准 `Date.now()`。

```ts
import { expiresIn, limit, prefix } from "@go-like/store"
import { background } from "@go-like/context"
import { newMemoryStore } from "@go-like/store-memory"

const store = newMemoryStore()
await store.write(
  background(),
  { key: "sessions/1", value: new TextEncoder().encode("active") },
  expiresIn(60_000)
)

const page = await store.list(background(), prefix("sessions/"), limit(100))
```
