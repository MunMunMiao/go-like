/** Written once at lifecycle start when no OTel ContextManager is registered. */
export const eventContextManagerMissing = "go_like.otel.context_manager_missing"

/** Written once at lifecycle start when the global propagator already owns `traceparent`. */
export const eventGlobalPropagator = "go_like.otel.global_propagator"
