import type { Handler } from "@likego/web"
import { Elysia } from "elysia"

import { newElysiaHandler, type ElysiaApplication } from "../src/index"

const app = new Elysia()
const handler: Handler = newElysiaHandler(app)
void handler

const routed = new Elysia().get("/users/:id", ({ params }) => params.id)
const routedHandler: Handler = newElysiaHandler(routed)
void routedHandler

const structural: ElysiaApplication = {
  fetch: (_request: Request) => new Response()
}
const structuralHandler: Handler = newElysiaHandler(structural)
void structuralHandler

// @ts-expect-error The native fetch boundary must return a standard Response.
newElysiaHandler({ fetch: (_request: Request) => 1 })
