# @likego/store

LikeGo 的可移植 Store 公共契约。它定义 Context-first CRUD、TTL、CAS、稳定分页、不可变快照和
provider 实现辅助入口，不提供全局默认实例、隐式 namespace、ORM、cache、watch 或 transaction DSL。

具体持久化实现由独立 provider 包提供。网络 provider 借用调用方的标准 Web `fetch`，构造后即可 CRUD；
只有确实拥有后台资源的 provider 才另外实现 `Server`。
Provider 作者可从 `@likego/store/provider` 导入 option、snapshot 与稳定冲突错误 helper；应用只使用根入口。

公共 `Store` 不提供 `capabilities()` 协商。各 provider 在自己的 README 记录固定边界；不支持的 option
会在外部副作用前拒绝，而不是静默降级。

## 条件写契约

- `ifAbsent()` 原子地只创建不存在的 key；它不是 `read()` 后再 `write()` 的进程内约定。
- `ifRevision(revision)` 原子地只替换 exact provider revision。
- 两者属于同一个 write condition，按 functional option 的既有 ordered/last-wins 规则生效；自定义 reducer
  同时提交两者会 fail closed。
- 条件不成立统一返回 `LIKEGO_STORE_CONFLICT`。`expectedRevision: null` 表示调用方期望 key 不存在，
  `actualRevision` 是冲突时观察到的 provider-opaque revision。

具体 provider 必须映射到后端原子原语或在 I/O 前拒绝，不能用非原子的 read-then-write 冒充。
