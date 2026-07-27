# Redis Cache 8.8.1 真实集成验证报告

验证日期：2026-07-26。

## 固定依赖

- 服务镜像：`redis:8.8.1-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb`
- Redis 服务版本：`8.8.1`
- 官方客户端：`@redis/client@6.1.0`

## 执行命令

```sh
LIKEGO_E2E_OWNER=redis-topology-gate bun run --filter @likego/cache-redis test:docker
```

## 已验证场景

- URL 单节点与 TLS/auth 节点分别完整运行 provider-neutral Cache conformance，各 5 项；
- 二进制值往返、覆盖写、miss、delete 与毫秒 TTL；
- namespace 隔离、损坏 carrier 协议错误与 Context 取消；
- 一个 primary、一个 replica 与三个 Sentinel；故障前从 replica 回读 carrier，kill primary 后由官方
  `createSentinel()` 发现新主节点，并继续读写；
- 三主三从 Cluster；确认故障 key 由待杀 master 持有并从目标 replica 回读 carrier，再 kill master、等待 replica
  晋升并验证故障前后跨 slot 读写；
- 生命周期停止后连接回收，结束后不存在残留测试容器、网络或卷。

## 实际终态

命令退出码为 `0`，终态标记为：

```text
LIKEGO_CACHE_REDIS_E2E_RESULT={"image":"redis:8.8.1-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb","redisVersion":"8.8.1","nodeRedisVersion":"6.1.0","conformanceCases":{"plain":5,"tls":5},"direct":{"binaryBytes":256,"protocolCode":"LIKEGO_CACHE_REDIS_PROTOCOL"},"tls":{"authenticated":true,"conformanceCases":5,"tls":true},"sentinel":{"rootNodes":3,"failedPrimary":"172.19.0.4","promotedPrimary":"172.19.0.5","replicatedBeforeFailover":true,"writeAfterFailover":true},"cluster":{"masters":3,"replicas":3,"failedMasterId":"28ce32c50e2f453bf1328da92013aa565683ad76","failedKeySlot":105,"promotedMasterId":"cab08d98788ac2ff761ab6740880c5d33d2322a0","crossSlotBeforeFailover":true,"crossSlotAfterFailover":true,"replicatedBeforeFailover":true},"cleanup":{"residualContainers":0,"residualNetworks":0,"residualVolumes":0}}
```

本报告只证明上述固定版本、固定脚本和场景在本次本地 Docker 运行中通过，不替代后续完整仓库发布门禁。
