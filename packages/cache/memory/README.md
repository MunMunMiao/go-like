# @likego/cache-memory

LikeGo 的进程内 Cache provider。每个实例拥有独立 Map，支持毫秒 TTL、lazy expiry、
写入与读取防御复制。构造后即可使用，不创建 timer、socket 或其他常驻资源。

该 provider 不启动后台 timer，也不在实例之间共享写入。停止实例会清空全部进程内值。
`clock` functional option 仅用于注入确定性时钟；未指定时直接使用标准 `Date.now()`。
