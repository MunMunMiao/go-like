import { struct } from "@go-like/struct"
import { defineService } from "@go-like/transport"

/** Defines the internal platform echo contract shared by Client and Server. */
export const echoService = defineService("platform-echo.v1", {
  ping: {
    response: struct.string()
  }
})
