# Broker and events

`@likego/broker` defines a Context-first byte-and-topic SPI for publish and subscribe. It keeps the provider’s native message on every delivery, because acknowledgement, negative acknowledgement, termination, redelivery, durability, and dead-letter behaviour are broker-specific and should not be flattened into dishonest common methods.

`@likego/event` is the optional typed layer. It encodes a detached byte payload on publish and decodes lazily on receive. A decode failure does not destroy the native NATS or JetStream object, so application code can still choose the correct settlement action.

`Broker.subscribe(ctx, topic, handler)` returns a provider `Subscriber` with `unsubscribe(ctx)`. `newBrokerServer(...)` adapts a `Broker` to the Core `Server` contract: `start(ctx)` represents the complete runtime and `stop(ctx)` requests shutdown. LikeGo owns the accepted subscription’s stop operation, but never the connection, stream, or durable consumer. Startup cancellation rolls back a subscription that was created but not admitted.

The recommended `@likego/broker-rabbitmq` entry uses the official `amqplib@2` recovery setup. The application still owns the connection, while LikeGo replays every active subscription's exchange, queue, binding, QoS, and consumer after recovery. A stable `Subscriber` never revives after unsubscribe, and `broker.ack/nack/reject(event.native)` targets only the channel generation that produced that delivery. An explicit borrowed-channel entry remains available when the application owns recovery completely.

Use a broker when delivery and fan-out are part of the domain. Use BullMQ through `@likego/bullmq` when the job queue’s retry, backoff, token, and worker behaviour are what you actually need. The adapter only joins an official `Worker` to lifecycle; it does not pretend the two models are the same.
