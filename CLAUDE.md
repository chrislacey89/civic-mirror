# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

The `effect` skill (`.claude/skills/effect`) adds opinionated v4 defaults for
services, schemas, config, scheduling, HTTP clients and tests. Where it differs
from code already in `src/`, follow the code: for example, typed errors here
extend `Data.TaggedError`, not the skill's `Schema.TaggedError`.
