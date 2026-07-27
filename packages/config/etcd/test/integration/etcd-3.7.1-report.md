# `@likego/config-etcd` etcd 3.7.1 Docker 验证

验证日期：2026-07-25（Asia/Shanghai）。

固定镜像：

```text
gcr.io/etcd-development/etcd:v3.7.1@sha256:a9983dd6d9283138ab926daa307c6c25623636703ecf5645d5df4d666ce9eba2
```

执行命令：

```sh
LIKEGO_E2E_OWNER=remediation-final bun run --filter @likego/config-etcd test:docker
```

实际结果（退出码 `0`）：

```text
LIKEGO_CONFIG_ETCD_DOCKER={"valid":true,"image":"gcr.io/etcd-development/etcd:v3.7.1@sha256:a9983dd6d9283138ab926daa307c6c25623636703ecf5645d5df4d666ce9eba2","etcdVersion":"3.7.1","initial":"2","update":"3","deleted":"4","compactedAt":"4","resourcesClean":true,"scenarios":["config-etcd-load-watch-delete-compaction"],"scenarioEvidence":{"config-etcd-load-watch-delete-compaction":{"initialLoaded":true,"updateObserved":true,"deleteObserved":true,"compactionRelisted":true}},"cleanup":{"remoteKeys":0,"watchersStopped":true,"containerRemoved":true}}
```

覆盖 exact-key linearizable range、initial revision 后的 streaming watch、update/delete 重载、forced
physical compaction 后 relist、容器内 `etcd --version` 精确返回 `3.7.1`，以及测试 key、watcher
与 Docker container 清理。
