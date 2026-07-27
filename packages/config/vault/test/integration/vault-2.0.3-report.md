# Vault Config 2.0.3 集成验证报告

日期：2026-07-24

## 运行基线

- 镜像：`hashicorp/vault:2.0.3`
- manifest digest：`sha256:a296a888b118615dc01d5f1a6846e6d4a7277946caaed5b447008fff5fe06b54`
- 容器内版本：`Vault v2.0.3 (7193f9a48ff6093ca61b3b627a8671e770428ba6)`
- 测试命令：`LIKEGO_E2E_OWNER=config-ux bun run --filter @likego/config-vault test:docker`

## 已验证场景

1. 使用错误 token 读取 KV v2 时返回稳定的 `LIKEGO_VAULT_HTTP` 边界错误。
2. 从 `secret/data/applications/orders/config` 读取完整配置对象，首次 revision 为 `1`。
3. watcher 轮询 metadata version；未变化时不发布，写入第二个版本后才完成 `next(ctx)`。
4. 第二次加载得到 revision `2` 与更新后的完整配置。
5. `stop(ctx)` 排空 watcher，`done()` 正常完成。
6. finally 阶段强制删除容器，并再次按测试标签确认零残留。

## 结果

```text
LIKEGO_CONFIG_VAULT_E2E_RESULT={"image":"hashicorp/vault:2.0.3@sha256:a296a888b118615dc01d5f1a6846e6d4a7277946caaed5b447008fff5fe06b54","version":"2.0.3","authentication":"LIKEGO_VAULT_HTTP","first":"1","second":"2","requests":4}
```

结果：通过。
