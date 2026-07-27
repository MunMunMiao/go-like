# `@likego/store-consul` Consul 2.0.2 真实 Docker 验证报告

## 执行基线

- 执行日期：2026-07-24（Asia/Shanghai）
- 执行命令：
  `LIKEGO_E2E_OWNER=codex-store-ux-alignment bun run --filter @likego/store-consul test:docker`
- 退出状态：`0`
- Docker Engine：`29.6.2`
- 容器内二进制：`Consul v2.0.2`
- 实际平台：`linux/arm64`
- 固定镜像：
  `hashicorp/consul:2.0.2@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2`
- 本机 RepoDigest：
  `hashicorp/consul@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2`
- 本次容器 image ID：
  `sha256:8bcaa83b7b2ad92ba0e1793d91506941b69de79f10eccdc72286b5739f7cc911`

## 场景结果

| 场景 | 真实观测 | 结果 |
| --- | --- | --- |
| 构造与首次操作 | 构造不执行 I/O；首次 CRUD/list 使用注入的标准 Fetch | 通过 |
| root 外 KV | 预先写入普通 Consul KV；默认 Store 空列表仍为空 | 通过 |
| 双 root 隔离 | 同一逻辑 key 在两个 root 中保持独立 value | 通过 |
| cursor 隔离 | 一个 root 生成的 cursor 在另一 root 中被拒绝 | 通过 |
| root 内坏数据 | 写入非 LikeGo envelope 后 list 返回 `LIKEGO_CONSUL_STORE_PROTOCOL` | 通过，fail closed |
| CRUD | 二进制 value 与 metadata 写入、读取、更新、删除完整 round-trip | 通过 |
| revision/CAS | `ModifyIndex` 在更新后变化；旧 revision 返回稳定 conflict | 通过 |
| prefix/list | recurse 查询后按 code point 得到 `A, a, 中, 😀`；两页 cursor 衔接无重复 | 通过 |
| TTL Session | KV 获得 behavior-delete Session；逻辑到期后 read 不可见 | 通过 |
| TTL 远端清理 | KV 与 exact Session 在 `10,188ms` 后同时不存在 | 通过 |
| client 独立性 | 新 Store client 可读写同一远端数据，旧 client 的消失不提前删除 TTL KV/Session | 通过 |
| 显式 delete | 删除 TTL record 后 exact KV 与其 Session 同时清零 | 通过 |
| `cas+acquire` | Consul 2.0.2 返回 HTTP `400`，body 含 `Conflicting flags:` | 通过，v1 fail closed 有真实依据 |
| restart | 单节点 server 容器 restart 后 persistent value 与原 revision 均保持 | 通过 |
| ACL deny | default-deny ACL 下匿名 Store 的真实操作返回 HTTP `403` | 通过 |
| ACL allow | management token 通过 `X-Consul-Token` 完成 CRUD 与 TTL delete | 通过 |
| token 边界 | 所有 provider URL 均无 token，Request 均为 `redirect: "error"` | 通过 |

restart 场景使用单节点 `-server -bootstrap-expect=1`，而不是会在进程重启时重建内存状态的 `-dev`；因此该结果
验证的是 Consul 持久化数据目录跨真实 agent restart 的行为。ACL 场景单独使用隔离的 default-deny dev agent，
避免与 restart 数据面共享权限状态。

## 机器输出摘要

```json
{
  "imageReferenceMatchesPinnedDigest": true,
  "binaryVersion": "Consul v2.0.2",
  "dockerEngine": "29.6.2",
  "primary": {
    "externalKvIgnored": true,
    "differentRootsIsolated": true,
    "crossRootCursorRejected": true,
    "corruptOwnedDataFailedClosed": true,
    "crudRoundTrip": true,
    "modifyIndexAdvanced": true,
    "staleConflict": true,
    "staleCursorRejected": true,
    "prefixOrder": ["A", "a", "中", "😀"],
    "clientIndependencePreservedTtl": true,
    "explicitDeleteRemovedExactSession": true,
    "casAcquireStatus": 400,
    "casAcquireConflictObserved": true,
    "logicallyExpired": true,
    "ttlRemovalMs": 10188,
    "restartPreserved": true
  },
  "acl": {
    "deniedStatus": 403,
    "authorizedRead": true,
    "ttlDeleted": true,
    "tokenOnlyInHeader": true
  }
}
```

## 最终资源回读

E2E 在移除容器前先通过 HTTP 回读远端资源，再按本次唯一 Docker label 检查容器：

| 资源 | 最终数量 |
| --- | ---: |
| primary 两个 integration root 与 root 外 KV | 0 |
| primary `likego-store:` Session | 0 |
| ACL integration prefix KV | 0 |
| ACL `likego-store:` Session | 0 |
| integration label container | 0 |

本报告只记录布尔结果、状态码、版本、digest 与资源数量；测试 ACL token 未进入机器输出或报告。
