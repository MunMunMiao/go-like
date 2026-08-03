import { background } from "@likego/context"
import * as HTTP from "@likego/transport-http"
import * as HTTPNode from "@likego/transport-http/node"

if (Object.keys(HTTP).join(",") !== "executor,maxMessageBytes,newHTTPTransport") {
  throw new Error(`unexpected @likego/transport-http exports: ${Object.keys(HTTP).join(",")}`)
}
if (Object.keys(HTTPNode).join(",") !== "allowHTTP1,clientAuth,newNodeHTTPTransport") {
  throw new Error(
    `unexpected @likego/transport-http/node exports: ${Object.keys(HTTPNode).join(",")}`
  )
}

const transport = HTTPNode.newNodeHTTPTransport(
  HTTPNode.clientAuth("none"),
  HTTPNode.allowHTTP1(true)
)
const listener = await transport.listen(background(), "127.0.0.1:0")
await listener.close(background())
