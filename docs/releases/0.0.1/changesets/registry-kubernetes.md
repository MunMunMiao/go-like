---
"@go-like/registry-kubernetes": minor
---

新增 Kubernetes `discovery.k8s.io/v1 EndpointSlice` Registry provider，支持 canonical identity、token、
`resourceVersion` CAS、namespace 聚合、foreign Slice 隔离与 `410 Gone` relist/re-watch。可显式提供同
namespace Pod 的 name/UID，使受管 EndpointSlice 在 Pod 删除后由 Kubernetes garbage collector 自动清理；
未提供 owner 时仍由应用显式 deregister。
