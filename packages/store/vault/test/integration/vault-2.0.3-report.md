# Vault Store 2.0.3 集成验证报告

日期：2026-07-24（Asia/Shanghai）

## 运行基线

- 镜像：`hashicorp/vault:2.0.3`
- manifest digest：`sha256:a296a888b118615dc01d5f1a6846e6d4a7277946caaed5b447008fff5fe06b54`
- 容器内版本：`Vault v2.0.3 (7193f9a48ff6093ca61b3b627a8671e770428ba6)`
- 测试命令：`bun run --filter @likego/store-vault test:docker`

## 已验证场景

1. 错误 token 在首次真实 list 操作中被拒绝。
2. 两个独立 root 之间不存在读写泄漏。
3. 完成二进制 value 的 write、read、list、delete，并验证稳定分页的后续 cursor 不再请求 Vault。
4. TTL 与 CAS 均在 I/O 前通过标准 `TypeError` fail closed。
5. delete 只 soft-delete 调用读取到的精确 version；请求发送前出现的并发新版本仍然可读。
6. token 只存在于 `X-Vault-Token` header，不进入 URL。
7. 清理两个远端测试 root，删除容器并按测试标签确认零残留。

## 结果

```text
LIKEGO_STORE_VAULT_E2E_RESULT={"schemaVersion":1,"valid":true,"package":"@likego/store-vault","image":"hashicorp/vault:2.0.3@sha256:a296a888b118615dc01d5f1a6846e6d4a7277946caaed5b447008fff5fe06b54","scenarios":["wrong-token","root-isolation","crud-stable-pagination","ttl-cas-fail-closed","exact-version-delete-concurrent-write","zero-residue"],"evidence":{"binaryVersion":"Vault v2.0.3 (7193f9a48ff6093ca61b3b627a8671e770428ba6), built 2026-06-17T12:39:45Z","wrongTokenDenied":true,"rootIsolation":true,"crud":true,"stablePagination":true,"ttlCasFailClosed":true,"exactVersionDeletePreservedConcurrentWrite":true,"tokenOnlyInHeader":true},"cleanup":{"remoteRoots":0,"containers":0}}
```

结果：通过。
