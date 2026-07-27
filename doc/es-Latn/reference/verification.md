# Verificación

LikeGo solo distingue dos clases de pruebas. `bun run test:unit` ejecuta pruebas unitarias deterministas sin servicios externos. `bun run test:e2e` construye los paquetes y verifica localmente proveedores reales, varios runtimes, ejemplos ejecutables y el consumo de tarballs publicados. Las suites Docker inician servicios reales y eliminan los recursos que crean.

El CI solo instala dependencias y ejecuta formato, tipos, build y pruebas unitarias. Los E2E con Docker, varios runtimes, ejemplos y soak se ejecutan localmente:

```sh
bun run test:unit
bun run test:e2e
bun run test:e2e:soak
```

`test:unit:coverage` solo genera un informe opcional. `fmt`, `typecheck`, `build`, `audit` y `doc:build` son comandos de ingeniería, no otras clases de pruebas. La existencia de un comando no demuestra que haya pasado; hay que revisar el estado terminal y los logs de la ejecución actual.
