# `@likego/store-etcd` etcd 3.7.1 真实 Docker 验证报告

## 执行基线

- 执行日期：2026-07-25（Asia/Shanghai）
- 执行命令：
  `LIKEGO_E2E_OWNER=remediation-final bun run --filter @likego/store-etcd test:docker`
- 退出状态：`0`
- Docker Engine：`29.6.2`
- 容器内 etcd：实际执行 `etcd --version` 返回 `3.7.1`
- 固定镜像：
  `gcr.io/etcd-development/etcd:v3.7.1@sha256:a9983dd6d9283138ab926daa307c6c25623636703ecf5645d5df4d666ce9eba2`

## 真实场景

| 场景 | 真实验证内容 | 结果 |
| --- | --- | --- |
| CRUD | value、metadata、revision 完整往返 | 通过 |
| prefix pagination | MVCC revision 固定的两页 cursor，无重复或遗漏 | 通过 |
| CAS | 旧 revision 的 write/delete 被 etcd transaction 拒绝 | 通过 |
| lease expiry/revoke | TTL 到期与显式 delete 后 exact lease 清理 | 通过 |
| new client/restart | 新 Store 与同一容器重启后读取持久 KV | 通过 |
| zero residual | 删除测试 namespace、lease 与测试容器 | 通过 |

## 机器输出

```text
LIKEGO_STORE_ETCD_DOCKER_V1={"valid":true,"image":"gcr.io/etcd-development/etcd:v3.7.1@sha256:a9983dd6d9283138ab926daa307c6c25623636703ecf5645d5df4d666ce9eba2","etcd":"3.7.1","checks":["crud","prefix-pagination","cas","lease-expiry","lease-revoke","new-client","restart","zero-residual"],"containerRemoved":true,"scenarios":["etcd-store-crud-cas-pagination","etcd-store-lease-restart"],"scenarioEvidence":{"etcd-store-crud-cas-pagination":{"crud":true,"casConflict":true,"stablePagination":true},"etcd-store-lease-restart":{"leaseExpired":true,"leaseRevoked":true,"clientIndependence":true,"restartPreserved":true}},"cleanup":{"remoteKeys":0,"remoteLeases":0,"containerRemoved":true}}
```

验证器在 `finally` 中移除本次容器，并用 `docker inspect` 反向确认容器不存在。
