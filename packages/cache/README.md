# @likego/cache

LikeGo 的可移植 Cache 公共契约。它定义 Context-first 的 `get`、`put`、`delete` 与可选 TTL；
需要管理真实资源的 provider 可另外实现 Core `Server`。

Cache 的值是原始 `Uint8Array`，写入和读取都执行防御复制；缺失和过期统一返回 `null`。
本包不提供全局默认实例、序列化、批处理、分布式锁、CAS、tag、namespace 或多级缓存。
具体实现放在独立 provider 包中，provider 自行校验 key、value 与 TTL 边界。
Provider 作者可从 `@likego/cache/provider` 导入 option snapshot helper；应用只使用根入口。
