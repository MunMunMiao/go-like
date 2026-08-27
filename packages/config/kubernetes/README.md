# @go-like/config-kubernetes

`@go-like/config-kubernetes` 使用调用方注入的标准 Web `fetch`，从一个命名空间内的
一个 ConfigMap 或 Secret 的一个 key 加载完整配置对象，并持续监视该对象。包不引入
Kubernetes SDK，也不拥有调用方的 Fetch、TLS 或认证生命周期。

```ts
import { kubernetesSource } from "@go-like/config-kubernetes"

const source = kubernetesSource({
  fetch(request) {
    return fetch(request)
  },
  address: "https://kubernetes.default.svc",
  namespace: "orders",
  kind: "ConfigMap",
  name: "orders-config",
  key: "config.json",
  token: process.env.KUBERNETES_TOKEN
})
```

初始读取使用精确 GET，并以对象 `metadata.resourceVersion` 建立无间隙 watch。
watch 使用 `metadata.name` field selector 和 bookmark；遇到 HTTP/Status 410 或可重试
中断时先按相同 selector LIST 对账，再继续。删除会触发重载，go-like Config 保留
last-good 值；同名对象重建后，后续 ADDED 事件会恢复加载。

`timeoutMs` 限制 GET/LIST 的完整响应和 watch 的 Fetch response admission。watch body
一旦接纳便由 watcher owner、调用方 Context 与 API `timeoutSeconds` 管理；静默时间不会
被 `timeoutMs` 误判为故障，API 正常关闭流后会从最后一个 bookmark 重新建立 watch。
`watcher.next(ctx)` 会在调用方 Context 取消时立即返回其 cause，已经启动的 body cleanup
仍由 watcher owner 跟踪。`watcher.stop(ctx)` 会中止 owner watch，并等待 active body
cancellation 完成和 reader lock 释放后再完成；若 stop Context 先取消，则只停止该调用方
的等待，底层清理仍会继续。

Secret 的 `data[key]` 先执行严格 base64 与 UTF-8 解码，再交给 decoder。公共 HTTP、
传输与协议错误不包含响应 body、Bearer token 或配置内容。调用方需要为目标资源提供
最小 `get/list/watch` RBAC 权限，并通过注入的 Fetch 配置集群 CA。

每个 source 只代表一个资源的一个 key；多个 source 会由 go-like Config 依次合并，但
Kubernetes API 不为这些独立资源提供跨资源事务快照。
