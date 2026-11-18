export {
  domain,
  families,
  interfaces,
  maxDecodedPayloadBytes,
  maxPacketBytes,
  onRegistrationError,
  port,
  queryTimeout,
  ttl,
  watchBufferSize
} from "./options"
export { newMDNSRegistry } from "./registry"
export type {
  MDNSAddress,
  MDNSBindOptions,
  MDNSDatagram,
  MDNSDatagramSocket,
  MDNSFamily,
  MDNSHost,
  MDNSMembership,
  MDNSNetworkInterface,
  MDNSOption,
  MDNSOptions,
  MDNSRegistry
} from "./types"
