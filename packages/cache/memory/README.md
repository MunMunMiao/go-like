# @go-like/cache-memory

go-like 的进程内 Cache provider。每个实例拥有独立 Map，支持毫秒 TTL、lazy expiry、
写入与读取防御复制。构造后即可使用，不创建 timer、socket 或其他常驻资源。

该 provider 不启动后台 timer，也不在实例之间共享写入；它没有 `start`、`stop` 或 `close` 生命周期。
需要移除值时显式调用 `delete(ctx, key)`；不再需要整个实例时，由应用释放对实例的引用。
`clock` functional option 仅用于注入确定性时钟；未指定时直接使用标准 `Date.now()`。
