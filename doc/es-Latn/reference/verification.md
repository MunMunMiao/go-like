# Verificación

go-like usa varias evidence lanes; no conviene reducir todos los resultados a dos clases de pruebas. `bun run test:unit` ejecuta pruebas unitarias deterministas sin servicios externos. `bun run test:e2e` construye los paquetes y verifica localmente proveedores reales, varios runtimes, ejemplos ejecutables y el consumo de tarballs publicados. Las suites Docker inician servicios reales y eliminan los recursos que crean.

Formato, tipos, build, Runtime E2E, Provider E2E, Example E2E, Published, Soak, Documentation build y Audit deben registrarse por separado. `test:unit:coverage` solo genera un informe opcional; consulta la [Verification canónica en inglés](/reference/verification) para las lanes, el baseline histórico y el run record documental.

```sh
bun run test:unit
bun run test:e2e
bun run test:e2e:soak
```

`test:unit:coverage` solo genera un informe opcional. `fmt`, `typecheck`, `build`, `audit` y `doc:build` son comandos de ingeniería, no otras clases de pruebas. `doc:build` comprueba las rutas VitePress del inglés y de los locales configurados; no demuestra el layout del navegador ni la paridad de traducción. La existencia de un comando no demuestra que haya pasado; hay que revisar el estado terminal y los logs de la ejecución actual. Consulta la [Verification canónica en inglés](/reference/verification) para las lanes, el baseline histórico y el run record documental.
