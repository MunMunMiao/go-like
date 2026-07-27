# `@likego/store-etcd` etcd 3.7.0 真实 Docker 验证报告

## 执行基线

- 执行日期：2026-07-24（Asia/Shanghai）
- 执行命令：
  `LIKEGO_E2E_OWNER=codex-store-ux-alignment bun run --filter @likego/store-etcd test:docker`
- 退出状态：`0`
- Docker Engine：`29.6.2`
- 容器内 etcd：`3.7.0`
- 固定镜像：
  `gcr.io/etcd-development/etcd:v3.7.0@sha256:6ecefbe2510c4a30573a62a4d6dd175acf881ca67003fcd91849a16df7a724d5`

## 真实场景

| 场景 | 真实验证内容 | 结果 |
| --- | --- | --- |
| CRUD | value、metadata、revision 完整往返 | 通过 |
| prefix pagination | MVCC revision 固定的两页 cursor，无重复或遗漏 | 通过 |
| CAS | 旧 revision 的 write/delete 被 etcd transaction 拒绝 | 通过 |
| lease expiry | 独立 TTL lease 到期后 key 与 lease 均消失 | 通过 |
| lease revoke | 显式 delete 后 exact lease 被主动撤销 | 通过 |
| new client | 新 Store 实例可立即读取旧实例写入的持久 KV | 通过 |
| restart | 同一真实容器重启后持久 KV 可恢复读取 | 通过 |
| zero residual | 删除测试 namespace 与 lease，移除测试容器 | 通过 |

Docker Desktop 在本次容器 restart 后重新分配了 ephemeral host port；验证器重新查询
`docker port`，没有把旧端口仍然可用当作假设。

## 机器输出

```text
LIKEGO_STORE_ETCD_DOCKER_V1={"valid":true,"image":"gcr.io/etcd-development/etcd:v3.7.0@sha256:6ecefbe2510c4a30573a62a4d6dd175acf881ca67003fcd91849a16df7a724d5","etcd":"3.7.0","checks":["crud","prefix-pagination","cas","lease-expiry","lease-revoke","new-client","restart","zero-residual"],"containerRemoved":true,"cleanup":{"remoteKeys":0,"remoteLeases":0,"containerRemoved":true}}
```

验证器在 `finally` 中移除本次唯一容器，并用 `docker inspect` 反向确认容器不存在。命令结束后再次按
`likego-store-etcd-*` 名称回读，残留容器数量为 `0`。
