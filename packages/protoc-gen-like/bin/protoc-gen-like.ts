#!/usr/bin/env node
import { runNodeJs } from "@bufbuild/protoplugin"
import { protocGenLike } from "../src/index.ts"

runNodeJs(protocGenLike)
