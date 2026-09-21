#!/usr/bin/env bun
import { runStorybook } from "./app"

const code = await runStorybook()
if (code !== 0) process.exit(code)

export { runStorybook }
