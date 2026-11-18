export { newClient, type Client } from "./client"
export type { ClientOptions, ServerOptions } from "./options"
export {
  withBlock,
  withDiscovery,
  withEndpoint,
  withSelector,
  withTLSConfig,
  type ClientOption
} from "./options"
export { newServer, type Server } from "./server"
export { address, advertise, clientAuth, tlsConfig, type ServerOption } from "./options"
