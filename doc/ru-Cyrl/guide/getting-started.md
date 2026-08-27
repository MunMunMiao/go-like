# Начало работы

Устанавливайте только нужные части. Обычному HTTP-сервису достаточно `@go-like/context`, `@go-like/core`, `@go-like/web` и Web-фреймворка с нативным Fetch handler. Для внутренних вызовов добавьте `@go-like/client`, `@go-like/transport` и `@go-like/transport-http`; registry, источник конфигурации и Store выбираются явно.

> [!IMPORTANT]
> Пакеты `@go-like/*` ещё не опубликованы в npm. В рабочей копии репозитория `workspace:*` разрешает зависимости в локальные пакеты `@go-like/*`; версия `0.0.1` в манифестах не означает, что они доступны в npm. Поэтому команда `bun add` ниже описывает путь после публикации. Чтобы проверить и запустить текущий исходный код из корня репозитория:
>
> ```sh
> bun install --frozen-lockfile
> bun run test:e2e:examples
> bun run --cwd examples/vanilla-web start
> ```

```sh
bun add @go-like/context @go-like/core @go-like/web
```

Создайте `src/main.ts`:

```ts
import process from "node:process"

import { background } from "@go-like/context"
import { afterStart, context, name, newApp, server, stopTimeout } from "@go-like/core"
import { signal } from "@go-like/core/node"
import type { Handler } from "@go-like/web"
import { newNodeServer, port } from "@go-like/web/node"

const handler: Handler = (request) => {
  const path = new URL(request.url).pathname
  return Response.json({ message: "hello from go-like", path })
}

const webServer = newNodeServer(handler, port(3000))
const app = newApp(
  context(background()),
  name("hello"),
  server(webServer),
  stopTimeout(30_000),
  signal(),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write("GO_LIKE_EXAMPLE_READY=hello\n")
  })
)

await app.run()
```

Запустите сервис:

```sh
bun run src/main.ts
```

Перед отправкой запросов дождитесь строки `GO_LIKE_EXAMPLE_READY=hello`. К приложению можно подключить любой объект, структурно реализующий интерфейс `Server`. `@go-like/croner`, `@go-like/bullmq`, `@go-like/pino` и `@go-like/winston` уже связывают популярные библиотеки с жизненным циклом, но не дублируют все их настройки.

Соединения, учётные данные, маршруты и настройки фреймворка по-прежнему создаёт приложение. В go-like передаётся минимальная возможность — обычно нативный объект или функция `fetch`. Так тесты остаются управляемыми, а при завершении понятно, кто закрывает каждый ресурс.
