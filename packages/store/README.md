# @likego/store

LikeGo 的可移植 Store 公共契约。它定义 Context-first CRUD、TTL、CAS、稳定分页、不可变快照和
provider 实现辅助入口，不提供全局默认实例、隐式 namespace、ORM、cache、watch 或 transaction DSL。

具体持久化实现由独立 provider 包提供。网络 provider 借用调用方的标准 Web `fetch`，构造后即可 CRUD；
只有确实拥有后台资源的 provider 才另外实现 `Server`。
Provider 作者可从 `@likego/store/provider` 导入 option、snapshot 与稳定冲突错误 helper；应用只使用根入口。

公共 `Store` 不提供 `capabilities()` 协商。各 provider 在自己的 README 记录固定边界；不支持的 option
会在外部副作用前拒绝，而不是静默降级。
