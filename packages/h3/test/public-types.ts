import type { Handler } from "@likego/web"
import { createApp } from "h3"

import { newH3Handler, type H3Application } from "../src/index"

const app = createApp()
const handler: Handler = newH3Handler(app)
void handler

const application: H3Application = app
void application

// @ts-expect-error A handler alone is not a complete H3 application.
newH3Handler({ handler: () => new Response() })
