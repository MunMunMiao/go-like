# Broker y eventos

`@likego/broker` define un SPI Context-first para publicar y suscribirse mediante topic y bytes. Cada entrega conserva el mensaje nativo del proveedor, porque `ack`, `nak`, `term`, redelivery, consumidores durables y dead letters tienen semánticas propias. Disfrazarlas con una interfaz común haría perder información útil.

`@likego/event` añade una capa tipada opcional. Al publicar codifica bytes independientes y, al recibir, espera hasta que la aplicación llama a `decode()` para validar el esquema. Si falla el decode, el `Msg` de NATS o `JsMsg` de JetStream sigue intacto y la aplicación puede decidir cómo liquidarlo.

`Broker.subscribe(ctx, topic, handler)` devuelve un `Subscriber` del proveedor con `unsubscribe(ctx)`. `newBrokerServer(...)` adapta un `Broker` al contrato Core `Server`: `start(ctx)` representa toda la ejecución y `stop(ctx)` solicita la parada. LikeGo se encarga de detener la suscripción aceptada, pero nunca posee la conexión, el stream ni el durable consumer. Si se cancela el arranque, revierte una suscripción creada pero aún no aceptada.

Elige Broker cuando necesitas entrega de eventos y fan-out. Si lo que manda es el modelo de jobs, retry, backoff, token y Worker de BullMQ, usa `@likego/bullmq`. No son lo mismo y una API honesta no debería fingir que sí.
