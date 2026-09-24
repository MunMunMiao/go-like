# Потоки

go-like использует потоковую модель самой Web-платформы. Запрос — обычный `Request`, ответ — обычный `Response`, а body может быть `ReadableStream<Uint8Array>`. Отдельного класса Stream, DSL для кадров и выдуманного двунаправленного канала поверх одноразового body здесь нет.

Публичный HTTP streaming принадлежит `@go-like/web` и нативному Handler выбранного фреймворка. Внутренние `@go-like/client` и `@go-like/transport` публикуют только unary-вызовы `Message`; отдельного Fetch Transport или Stream Client нет.

Web body читается только один раз. Middleware не должен потреблять его, если не собирается явно предоставить замену. Отмена проходит через первый `Context` и signal запроса. Transport проверяет, что каждый chunk является `Uint8Array`; неверное значение превращается в ошибку протокола, а не в загадочно пустые данные.

Для внешнего HTTP используйте `@go-like/web` вместе с Hono, Elysia, H3 или собственным handler. SSE, потоковые ответы и runtime-specific WebSocket upgrade остаются в исходном фреймворке; go-like сохраняет нативные объекты и ошибки.

`contextHandler` освобождает свой Context после возврата Response из Handler, а не после завершения body. Долгоживущий producer должен следить за `request.signal` или владеть отдельной областью отмены.

`@go-like/protoc-gen-like` генерирует Protobuf RPC с первым аргументом `Context` на основе Protobuf-ES. `@go-like/transport-grpc-buf` предоставляет unary и server-streaming Connect/gRPC-Web через Fetch; `/native` добавляет стандартный gRPC со всеми четырьмя видами вызовов, включая client-streaming и bidi. Этот путь независим от unary Transport SPI.

Совместимость не доказывает производственную надёжность: drain с медленным потребителем завершается ошибкой в Deno 2.9.5/2.9.7; Connect 2.1.2 сохраняет таймер deadline после отмены приостановленного потока ответа; отмена Fetch в Bun 1.4.2 не достигает сервера, молчащего после первого chunk. См. [доказательства и ограничения](/reference/claims#stream-cancellation-limits); go-like не исправляет эти дефекты.
