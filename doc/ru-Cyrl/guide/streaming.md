# Потоки

LikeGo использует потоковую модель самой Web-платформы. Запрос — обычный `Request`, ответ — обычный `Response`, а body может быть `ReadableStream<Uint8Array>`. Отдельного класса Stream, DSL для кадров и выдуманного двунаправленного канала поверх одноразового body здесь нет.

Публичный HTTP streaming принадлежит `@likego/web` и нативному Handler выбранного фреймворка. Внутренние `@likego/client` и `@likego/transport` публикуют только unary-вызовы `Message`; отдельного Fetch Transport или Stream Client нет.

Web body читается только один раз. Middleware не должен потреблять его, если не собирается явно предоставить замену. Отмена проходит через первый `Context` и signal запроса. Transport проверяет, что каждый chunk является `Uint8Array`; неверное значение превращается в ошибку протокола, а не в загадочно пустые данные.

Для внешнего HTTP используйте `@likego/web` вместе с Hono, Elysia, H3 или собственным handler. SSE, потоковые ответы и runtime-specific WebSocket upgrade остаются в исходном фреймворке; LikeGo сохраняет нативные объекты и ошибки.
