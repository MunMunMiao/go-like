import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"
import type {
  AcquirePickLease,
  AcquirePickLeaseCommand,
  CompletePickTask,
  CompletePickTaskCommand
} from "./service"

function taskIdFrom(pathname: string, suffix: string): string | null {
  const prefix = "/v1/pick-tasks/"
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null
  const end = pathname.length - suffix.length
  const taskId = decodeURIComponent(pathname.slice(prefix.length, end))
  return taskId.length === 0 ? null : taskId
}

function acquireCommandFrom(taskId: string, value: unknown): AcquirePickLeaseCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const workerId: unknown = Reflect.get(value, "workerId")
  const leaseMs: unknown = Reflect.get(value, "leaseMs")
  if (typeof workerId !== "string" || typeof leaseMs !== "number") {
    throw new TypeError("invalid lease command")
  }
  return Object.freeze({ taskId, workerId, leaseMs })
}

function completeCommandFrom(taskId: string, value: unknown): CompletePickTaskCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
  const workerId: unknown = Reflect.get(value, "workerId")
  const fencingToken: unknown = Reflect.get(value, "fencingToken")
  if (typeof workerId !== "string" || typeof fencingToken !== "number") {
    throw new TypeError("invalid completion command")
  }
  return Object.freeze({ taskId, workerId, fencingToken })
}

/** Creates the standard Fetch entrypoint for pick-task leasing. */
export function newWarehousePickingHandler(
  acquirePickLease: AcquirePickLease,
  completePickTask: CompletePickTask
): Handler {
  return contextHandler(async function warehousePickingHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    try {
      const leaseTaskId = taskIdFrom(url.pathname, "/lease")
      if (request.method === "POST" && leaseTaskId !== null) {
        const command = acquireCommandFrom(leaseTaskId, await request.json())
        return Response.json(acquirePickLease(ctx, command), { status: 201 })
      }
      const completeTaskId = taskIdFrom(url.pathname, "/complete")
      if (request.method === "POST" && completeTaskId !== null) {
        const command = completeCommandFrom(completeTaskId, await request.json())
        return Response.json(completePickTask(ctx, command))
      }
      return Response.json({ code: "not_found" }, { status: 404 })
    } catch (error) {
      const message = error instanceof Error ? error.message : "pick task operation failed"
      const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
      return Response.json({ code: "pick_task_rejected", message }, { status })
    }
  })
}
