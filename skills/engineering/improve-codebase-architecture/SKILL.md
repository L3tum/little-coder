---
name: improve-codebase-architecture
description: Find deepening opportunities in a codebase and propose refactors that improve architecture, testability, and AI-navigability.
type: workflow
token_cost: 150
keywords: [architecture, codebase architecture, refactor, refactoring, testability, module, interface, deep module, shallow module, seam, adapter, locality, leverage]
requires_tools: [code_search, lsp, read, write]
---
# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

## Glossary

Use these terms exactly in every suggestion:

- **Module** — anything with an interface and an implementation (function, class, package, slice).
- **Interface** — everything a caller must know to use the module: types, invariants, error modes, ordering, config.
- **Implementation** — the code inside.
- **Depth** — leverage at the interface: a lot of behaviour behind a small interface. Deep = high leverage. Shallow = interface nearly as complex as the implementation.
- **Seam** — where an interface lives; a place behaviour can be altered without editing in place.
- **Adapter** — a concrete thing satisfying an interface at a seam.
- **Leverage** — what callers get from depth.
- **Locality** — what maintainers get from depth: change, bugs, knowledge concentrated in one place.

Key principles:

- **Deletion test**: imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.**
- **One adapter = hypothetical seam. Two adapters = real seam.**

## Process

1. Explore domain glossary/docs and ADRs first.
2. Use code_search/lsp/read to identify friction:
   - understanding one concept requires bouncing through many small modules;
   - modules are shallow;
   - pure functions were extracted for testability but bugs hide in orchestration;
   - tightly-coupled modules leak across seams;
   - tests are missing or hard to write through the current interface.
3. Present candidates with: files, problem, solution, benefits in terms of locality/leverage, before/after structure, and recommendation strength.
4. End with a top recommendation and ask which candidate to explore.
5. Do not implement refactors until the user chooses one.
