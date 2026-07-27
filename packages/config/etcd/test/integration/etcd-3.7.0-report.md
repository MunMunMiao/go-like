# @likego/config-etcd etcd 3.7.0 Docker 验证

验证日期：2026-07-24

固定镜像：

```text
gcr.io/etcd-development/etcd:v3.7.0@sha256:6ecefbe2510c4a30573a62a4d6dd175acf881ca67003fcd91849a16df7a724d5
```

执行命令：

```sh
LIKEGO_E2E_OWNER=config-ux bun run --filter @likego/config-etcd test:docker
```

实际结果：

```text
LIKEGO_CONFIG_ETCD_DOCKER={"valid":true,"image":"gcr.io/etcd-development/etcd:v3.7.0@sha256:6ecefbe2510c4a30573a62a4d6dd175acf881ca67003fcd91849a16df7a724d5","initial":"2","update":"3","deleted":"4","compactedAt":"4","resourcesClean":true,"scenarios":["config-etcd-load-watch-delete-compaction"],"scenarioEvidence":{"config-etcd-load-watch-delete-compaction":{"initialLoaded":true,"updateObserved":true,"deleteObserved":true,"compactionRelisted":true}},"cleanup":{"remoteKeys":0,"watchersStopped":true}}
```

覆盖行为：

- dynamic host port 与 `/health` readiness；
- exact-key linearizable range；
- 从 initial revision + 1 建立 streaming watch；
- update 与 delete 事件驱动完整重载；
- delete 后缺失 key 映射为空配置对象；
- forced physical compaction 后 fresh range 恢复；
- 测试 key 删除；
- Docker container 删除并通过 `docker inspect` 反向确认无残留。
