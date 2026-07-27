# @likego/config-etcd

`@likego/config-etcd` 使用调用方注入的标准 Web `fetch` 访问 etcd v3 JSON gRPC gateway，加载并监视一个精确 KV key。包不引入 gRPC 或 Protobuf runtime，也不拥有调用方的 Fetch、TLS 或认证生命周期。

```ts
import { etcdSource } from "@likego/config-etcd"

const source = etcdSource({
  fetch(request) {
    return fetch(request)
  },
  address: "http://127.0.0.1:2379",
  key: "applications/orders/config"
})
```

初始读取使用 linearizable range，并以响应 header revision 作为 watch 游标。watch 从该 revision 加一开始，create、update 和 delete 都会触发完整配置重算；遇到 compaction 或连接恢复时先执行 fresh range，再恢复监视。底层不可用期间由现有 Config 保留 last-good 配置值。

token 只通过 `Authorization` header 发送，重定向被拒绝；公共错误不保留响应 body、token 或底层传输错误文本。

## 真实服务门禁

Docker 门禁固定使用 etcd 3.7.1，覆盖初始加载、update/delete watch、compaction relist 与资源清理。固定
镜像、执行命令和机器输出见
[etcd 3.7.1 验证报告](https://github.com/MunMunMiao/likego/blob/main/packages/config/etcd/test/integration/etcd-3.7.1-report.md)。
