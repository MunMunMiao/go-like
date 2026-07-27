import type { Context } from "@likego/context"
import type { Server } from "@likego/core"
import type { Cron } from "croner"

/** Constructs one or more native Croner jobs inside the Server startup boundary. */
export type CronerFactory<T = undefined> = (ctx: Context) => Cron<T> | readonly Cron<T>[]

/** A one-shot structural Server that owns only native Croner lifecycle. */
export interface CronerServer extends Server {}
