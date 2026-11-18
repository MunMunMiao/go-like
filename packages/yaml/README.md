# @go-like/yaml

YAML 1.2 `ConfigDecoder` 的一个解码函数。公开入口只有 `@go-like/yaml/config`。它不监视文件，也不读取文件系统。

## 依赖

| 种类 | 包              | 范围    |
| ---- | --------------- | ------- |
| peer | `@go-like/core` | `0.0.1` |
| 常规 | `js-yaml`       | `5.5.0` |

没有可选 peer。`@go-like/core` 的 dev 依赖是 `workspace:*`。通道可移植。

## 示例

```ts
import { decodeYaml } from "@go-like/yaml/config"

const document = decodeYaml("listen: 127.0.0.1:9000\n", "file:config.yaml")
void document
```

`decodeYaml` 的签名就是 `ConfigDecoder`。文件源把它放在第三个参数里：
`fileSource(capability, path, { decode: decodeYaml })`。

## 错误码

本包不定义 `GO_LIKE_` 错误码。输入不是字符串、origin 为空、文档不是恰好一份对象、语法不受支持，或整数超出安全范围时，抛出 `TypeError`。
