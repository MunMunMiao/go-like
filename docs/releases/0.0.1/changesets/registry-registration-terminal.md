---
"@likego/registry": minor
"@likego/registry-consul": minor
"@likego/registry-etcd": minor
"@likego/registry-kubernetes": minor
"@likego/registry-mdns": minor
"@likego/registry-zookeeper": minor
---

# Registry 后台注册终态通知

- `@likego/registry/provider` 增加共享 `RegistrationErrorHandler`、`ProviderOptionInput.onRegistrationError` 与安全通知 helper。
- Consul、etcd、ZooKeeper 与 mDNS 在 resident registration generation 永久失效后通知一次防御性服务快照。
- Kubernetes 接受同一公共 option，但没有 resident renewal，不会伪造后台回调。
- retryable failure 保持既有 backoff；callback throw/rejection 被观察并隔离，Registrar/Registry SPI 不变。
