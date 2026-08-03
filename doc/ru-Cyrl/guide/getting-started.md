# Начало работы

Устанавливайте только нужные части. Обычному HTTP-сервису достаточно `@likego/context`, `@likego/core`, `@likego/web` и Web-фреймворка с нативным Fetch handler. Для внутренних вызовов добавьте `@likego/client`, `@likego/transport` и `@likego/transport-http`; registry, источник конфигурации и Store выбираются явно.

> [!IMPORTANT]
> Пакеты `@likego/*` ещё не опубликованы в npm. В рабочей копии репозитория `workspace:*` разрешает зависимости в локальные пакеты `@likego/*`; версия `0.0.1` в манифестах не означает, что они доступны в npm. Поэтому команда `bun add` ниже описывает путь после публикации. Чтобы проверить и запустить текущий исходный код из корня репозитория:
>
> ```sh
> bun install --frozen-lockfile
> bun run test:e2e:examples
> bun run --cwd examples/vanilla-web start
> ```

```sh
bun add @likego/context @likego/core @likego/web
```

Создайте `src/main.ts`:

```ts
import { background } from "@likego/context"
import { context, name, newApp, server, stopTimeout } from "@likego/core"
import { signal } from "@likego/core/node"
import type { Handler } from "@likego/web"
import { newNodeServer, port } from "@likego/web/node"

const handler: Handler = (request) => {
  const path = new URL(request.url).pathname
  return Response.json({ message: "hello from LikeGo", path })
}

const app = newApp(
  context(background()),
  name("hello"),
  server(newNodeServer(handler, port(3000))),
  stopTimeout(30_000),
  signal()
)

await app.run()
```

Запустите сервис:

```sh
bun run src/main.ts
```

К приложению можно подключить любой объект, структурно реализующий интерфейс `Server`. `@likego/croner`, `@likego/bullmq`, `@likego/pino` и `@likego/winston` уже связывают популярные библиотеки с жизненным циклом, но не дублируют все их настройки.

Соединения, учётные данные, маршруты и настройки фреймворка по-прежнему создаёт приложение. В LikeGo передаётся минимальная возможность — обычно нативный объект или функция `fetch`. Так тесты остаются управляемыми, а при завершении понятно, кто закрывает каждый ресурс.
