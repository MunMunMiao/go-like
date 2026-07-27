import type { Handler } from "@likego/web"
import { Hono } from "hono"

import { newHonoHandler } from "../src/index"

const app = new Hono()
const handler: Handler = newHonoHandler(app)
void handler

// @ts-expect-error Hono is the required native application type.
newHonoHandler({ fetch: (_request: Request) => new Response() })
