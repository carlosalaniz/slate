#!/usr/bin/env bun
import { main } from "../src/cli/main.ts"

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err))
    process.exit(1)
  },
)
