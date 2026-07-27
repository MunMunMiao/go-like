# Redis Cache 8.8.0 真实集成验证报告

验证日期：2026-07-22。

## 固定依赖

- 服务镜像：`redis:8.8.0-alpine@sha256:9d317178eceac8454a2284a9e6df2466b93c745529947f0cd42a0fa9609d7005`
- Redis 服务版本：`8.8.0`
- 官方客户端：`@redis/client@6.1.0`

## 执行命令

```sh
cd packages/cache/redis
bun run test:docker
```

## 已验证场景

- 完整运行 provider-neutral Cache conformance，共 5 项；
- 二进制值往返、覆盖写、miss 与 delete；
- 毫秒 TTL 过期；
- 不同 key prefix 的 namespace 隔离；
- 损坏 carrier 返回稳定协议错误；
- Context 取消与生命周期停止后连接回收；
- 使用 run-id 容器名和 label 清理，结束后不存在残留测试容器。

## 实际终态

命令退出码为 `0`，终态标记为：

```text
LIKEGO_CACHE_REDIS_E2E_RESULT={"image":"redis:8.8.0-alpine@sha256:9d317178eceac8454a2284a9e6df2466b93c745529947f0cd42a0fa9609d7005","redisVersion":"8.8.0","nodeRedisVersion":"6.1.0","conformanceCases":5,"direct":{"binaryBytes":256,"protocolCode":"LIKEGO_CACHE_REDIS_PROTOCOL"}}
```

本报告只证明上述固定版本、固定脚本和场景在本次本地 Docker 运行中通过，不替代后续完整仓库发布门禁。
