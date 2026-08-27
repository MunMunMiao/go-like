---
"@go-like/broker": patch
"@go-like/event": patch
"@go-like/nats": patch
---

增加 provider-neutral Broker、显式 typed Event codec 层，以及保留原生 `Msg`、`JsMsg` 与 `PubAck`
语义的 NATS Core 和 JetStream provider。Event 解码前会校验唯一的 `content-type` 与 codec
`mediaType` 一致。
