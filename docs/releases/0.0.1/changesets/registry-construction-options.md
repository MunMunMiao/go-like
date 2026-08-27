---
"@go-like/registry": minor
"@go-like/registry-consul": minor
"@go-like/registry-etcd": minor
"@go-like/registry-kubernetes": minor
"@go-like/registry-mdns": minor
"@go-like/registry-zookeeper": minor
---

将 Registry 公共体验统一为 Kratos 风格的构造期配置：删除运行期可变的
`init/options/string`，Consul、etcd、Kubernetes 与 ZooKeeper provider 在构造时接收
Registry options；mDNS 继续使用已有的 `MDNSOption`。
