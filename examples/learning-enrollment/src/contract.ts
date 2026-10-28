import { struct } from "@go-like/struct"
import { defineService } from "@go-like/transport"

const capacityRequest = struct.object({
  requestId: struct.string(),
  courseId: struct.string()
})

const capacityReply = struct.object({
  remainingSeats: struct.number()
})

/** Defines the internal course-capacity contract shared by Client and Server. */
export const learningCapacity = defineService("learning-capacity.v1", {
  reserve: {
    request: capacityRequest,
    response: capacityReply
  }
})
