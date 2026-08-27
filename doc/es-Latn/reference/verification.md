# Verificación

go-like usa varias evidence lanes; no conviene reducir todos los resultados a dos clases de pruebas. `bun run test:unit` ejecuta pruebas unitarias deterministas sin servicios externos. `bun run test:e2e` construye los paquetes y verifica localmente proveedores reales, varios runtimes, ejemplos ejecutables y el consumo de tarballs publicados. Las suites Docker inician servicios reales y eliminan los recursos que crean.

Formato, Lint, tipos, build, Runtime E2E, Provider E2E, Example E2E, Published, Soak, Documentation build y Audit deben registrarse por separado. La verificación canónica del repositorio es `bun run verify`: ejecuta en orden `fmt:check`, `lint`, `typecheck`, `build`, `test:unit` y `test:unit:coverage`, incluida la verificación obligatoria de cobertura. Consulta la [Verification canónica en inglés](/reference/verification) para las lanes, el baseline histórico y el run record documental.

```sh
bun run verify
bun run test:e2e
bun run test:e2e:soak
```

Los comandos de cada fase sirven solo para acotar un fallo; superar una fase no sustituye `bun run verify`. `bun run lint` comprueba las reglas estáticas de Oxlint; no equivale a comprobar tipos ni a ejecutar comportamiento en runtime. E2E y soak siguen siendo comprobaciones locales independientes que se ejecutan cuando hacen falta. `fmt`, `lint`, `typecheck`, `build`, `audit` y `doc:build` son comandos de ingeniería, no otras clases de pruebas. `doc:build` comprueba las rutas VitePress del inglés y de los locales configurados; no demuestra el layout del navegador ni la paridad de traducción. La existencia de un comando no demuestra que haya pasado; hay que revisar el estado terminal y los logs de la ejecución actual. Consulta la [Verification canónica en inglés](/reference/verification) para las lanes, el baseline histórico y el run record documental.
