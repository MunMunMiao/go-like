---
"@go-like/broker-rabbitmq": minor
"@go-like/config-kubernetes": minor
---

新增 RabbitMQ Broker provider 与 Kubernetes Config provider；两者分别保留 AMQP 原生 delivery 语义和
Kubernetes `resourceVersion` watch 语义，并纳入固定镜像的真实 Docker 发布门禁。
