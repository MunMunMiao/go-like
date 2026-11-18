# @go-like/kubernetes

共享的 Kubernetes API 客户端，以及填在它上面的 Registry 与 Config 插座。没有 Store 入口。根入口不是插座。`token` 以 `Authorization: Bearer` 发送。

## 入口

| 入口                           | 填充的插座                            | 关键导出                                  |
| ------------------------------ | ------------------------------------- | ----------------------------------------- |
| `@go-like/kubernetes`          | 无。共享客户端                        | `newKubernetesClient`、`KubernetesClient` |
| `@go-like/kubernetes/registry` | `Registry`                            | `newKubernetesRegistry`                   |
| `@go-like/kubernetes/config`   | `ConfigSource`、`ConfigSourceWatcher` | `kubernetesSource`                        |

通道均可移植。Registry 管理同一命名空间里的 `discovery.k8s.io/v1` EndpointSlice。

## 依赖

没有第三方运行时依赖，也没有可选 peer。`@go-like/core` 的 peer 是锁步精确版本 `0.0.1`，dev 依赖是 `workspace:*`。

## 示例

```ts
import { newKubernetesClient } from "@go-like/kubernetes"
import { kubernetesSource } from "@go-like/kubernetes/config"
import { newKubernetesRegistry } from "@go-like/kubernetes/registry"

const api = newKubernetesClient({
  fetch,
  address: "https://kubernetes.default.svc",
  token: process.env["KUBERNETES_TOKEN"]
})
const registry = newKubernetesRegistry(api, { namespace: "default" })
const source = kubernetesSource(api, {
  namespace: "default",
  configMap: "orders",
  key: "config"
})
```

## 错误码

| 代码                           | 类型                       |
| ------------------------------ | -------------------------- |
| `GO_LIKE_KUBERNETES_HTTP`      | `KubernetesHttpError`      |
| `GO_LIKE_KUBERNETES_TRANSPORT` | `KubernetesTransportError` |
| `GO_LIKE_KUBERNETES_PROTOCOL`  | `KubernetesProtocolError`  |
