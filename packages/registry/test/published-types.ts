import { background } from "@go-like/context"
import { type Metadata } from "@go-like/metadata"
import {
  filterLabel,
  filterVersion,
  newEWMASelector,
  type EWMASelectorOptions,
  type Registry,
  type SelectionOutcome,
  type ServiceInstance
} from "@go-like/registry"
import {
  notifyRegistrationError,
  providerOptions,
  snapshotServiceInstance,
  type ProviderOptionInput,
  type RegistrationErrorHandler
} from "@go-like/registry/provider"

const service: ServiceInstance = snapshotServiceInstance({
  id: "published-1",
  name: "published",
  version: "v1",
  metadata: {},
  endpoints: ["memory://published"]
})
declare const registry: Registry
const registrationErrorHandler: RegistrationErrorHandler = (_error, _service) => {}
const providerInput: ProviderOptionInput = { onRegistrationError: registrationErrorHandler }
const capturedProviderOptions = providerOptions(providerInput)
notifyRegistrationError(capturedProviderOptions.onRegistrationError, new Error("terminal"), service)
const ewmaOptions: EWMASelectorOptions = {
  random: () => 0,
  now: () => 0,
  isFailure: (error) => error.name === "ApplicationFailure"
}
declare const replyMetadata: Metadata
const compatibleOutcome: SelectionOutcome = { error: null }
const detailedOutcome: SelectionOutcome = {
  error: null,
  replyMetadata,
  bytesSent: true,
  bytesReceived: true
}

void newEWMASelector(ewmaOptions)
void filterVersion("v1")([service])
void filterLabel("zone", "a")([service])
void registry.register(background(), service)
void registry.deregister(background(), service)
void compatibleOutcome
void detailedOutcome
void capturedProviderOptions
