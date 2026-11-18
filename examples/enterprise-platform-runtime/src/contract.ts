import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"

/** Defines the internal platform echo contract shared by Client and Server. */
export const echoService = defineService("platform-echo.v1", {
  ping: {
    response: struct.string()
  }
})
