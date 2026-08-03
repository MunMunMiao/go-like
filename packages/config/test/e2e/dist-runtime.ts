import { background } from "@likego/context"
import { newConfig, objectSource, placeholderResolver, resolver, source } from "@likego/config"

const config = newConfig(
  source(objectSource("one", { host: "service", endpoint: "https://${host}" })),
  resolver(placeholderResolver())
)
await config.load(background())
if (config.value("endpoint").load() !== "https://service") {
  throw new Error("published Config placeholder resolution failed")
}
await config.close(background())
