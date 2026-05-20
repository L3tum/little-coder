---
name: skills-finder
type: tool-guidance
target_tool: skills
priority: 5
token_cost: 80
user-invocable: true
---
## skills Tool / Command
List all available skills (tool skills, knowledge entries, protocols).

Usage: `skills` or `/skills`

Shows three categories:
- **Tool Skills** — per-tool usage guidance cards injected into the system prompt on demand (error-recovery > recency > intent priority).
- **Knowledge** — algorithm cheat sheets scored against the user's prompt and injected when keywords match (threshold 2.0).
- **Protocols** — research/cite/decomposition workflows injected for research-heavy tasks.

Skills live under the `skills/` directory at the repo root:
- `skills/tools/*.md` — tool skill cards (14 files)
- `skills/knowledge/*.md` — algorithm cheat sheets (13 files)
- `skills/protocols/*.md` — research workflows (3 files)

To find and install new skills from the open agent skills ecosystem, use `npx skills find <query>`.
