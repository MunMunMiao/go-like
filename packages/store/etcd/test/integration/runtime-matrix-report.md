# `@likego/store-etcd` 运行时发布形态验证报告

## 执行基线

- 执行日期：2026-07-24（Asia/Shanghai）
- 执行命令：`bun run --filter @likego/store-etcd test:runtime`
- 退出状态：`0`

验证器把已构建的 `@likego/context`、`@likego/core`、`@likego/store` 与 `@likego/store-etcd`
发布目录直接放入临时 publish-shaped `node_modules`。测试代码只通过 `@likego/*` 包名导入，不引用
workspace source 或相对 `dist/*.js` 路径。

| Runtime lane | 实测版本/固定镜像 | 结果 |
| --- | --- | --- |
| Bun exact | `1.3.14` | 通过 |
| Node current | `26.5.0` | 通过 |
| Deno exact | `2.9.3` | 通过 |
| Node LTS Docker | `24.18.0` / `node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d` | 通过 |

四条 lane 均得到完全一致的输出：

```json
{"name":"etcd","records":0,"cursor":null,"calls":1,"paths":["/v3/kv/range"]}
```

场景覆盖标准 `Request`、POST、JSON content type、`redirect: "error"`、构造后直接执行空 prefix list，
以及 provider 名称。临时发布目录由 `finally` 删除；机器输出确认 `temporaryStageCleaned: true`。
