import { background } from "@likego/context"
import type { Transport } from "@likego/transport"

import {
  executor,
  maxMessageBytes,
  newHTTPTransport,
  type HTTPExecutor,
  type HTTPTransport,
  type HTTPTransportOption,
  type HTTPTransportOptions
} from "../src/index"
import {
  allowHTTP1,
  clientAuth,
  newNodeHTTPTransport,
  type NodeHTTPClientAuth,
  type NodeHTTPTransportOption,
  type NodeHTTPTransportOptions
} from "../src/node"

declare const fetchExecutor: HTTPExecutor
const executorOption: HTTPTransportOption = executor(fetchExecutor)
const limitOption: HTTPTransportOption = maxMessageBytes(1)
const portable: HTTPTransport = newHTTPTransport(executorOption, limitOption)
const authentication: NodeHTTPClientAuth = "require"
const nodeOption: NodeHTTPTransportOption = clientAuth(authentication)
const nodeOptions: NodeHTTPTransportOptions = {
  allowHTTP1: false,
  clientAuth: authentication
}
const node: Transport = newNodeHTTPTransport(limitOption, nodeOption, allowHTTP1(false))
const options: HTTPTransportOptions = {
  executor: fetchExecutor,
  maxMessageBytes: 1
}
const dial = node.dial(background(), "127.0.0.1:8080")

void [portable, node, nodeOptions, options, dial]

// @ts-expect-error HTTP message limits must be numbers.
maxMessageBytes("1")

// @ts-expect-error Node client authentication is a closed policy.
clientAuth("optional")
