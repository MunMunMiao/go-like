import { background } from "@likego/context"
import { newHandler } from "@likego/example-vanilla-web"
import { newNodeServer } from "@likego/web/node"

const server = newNodeServer(newHandler())
const endpoint = await server.endpoint(background())
const running = server.start(background())
try {
  const response = await fetch(new URL("/live", endpoint))
  const body = await response.text()
  if (response.status !== 200 || body !== '{"method":"GET","path":"/live"}') {
    throw new Error(`unexpected vanilla Fetch response: ${response.status} ${body}`)
  }
} finally {
  await server.stop(background())
  await running
}
