---
"@likego/registry": minor
"@likego/registry-consul": minor
"@likego/registry-etcd": minor
"@likego/registry-kubernetes": minor
"@likego/registry-mdns": minor
"@likego/registry-zookeeper": minor
---

将 Registry 公共体验统一为 Kratos 风格的构造期配置：删除运行期可变的
`init/options/string`，Consul、etcd、Kubernetes 与 ZooKeeper provider 在构造时接收
Registry options；mDNS 继续使用已有的 `MDNSOption`。
