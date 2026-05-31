---
name: skills-finder
type: tool-guidance
target_tool: skills
priority: 5
token_cost: 80
user-invocable: true
description: Guidance for listing and loading installed skills by name, type, origin, and description.
keywords: [skills, list, load, description, keywords, skill, guidance]
---
## skills Tool / Command
List all available skills (tool skills, knowledge entries, protocols, repo skills, and user-level skills).

Usage: `skills` or `/skills`

Shows three categories:
- **Tool Skills** — per-tool usage guidance cards injected into the system prompt on demand (error-recovery > recency > intent priority).
- **Knowledge** — algorithm cheat sheets scored against the user's prompt and injected when keywords match (threshold 2.0).
- **Protocols** — research/cite/decomposition workflows injected for research-heavy tasks.

The listing includes each skill's token cost, origin (`repo` or `user`), keywords, and frontmatter description/fallback first line.

Skills load from:
- repo `skills/` — packaged canonical skills
- user `~/.pi/skills/` — local reflection-generated or installed skills; exact explicit loads prefer user skills when names collide

Use `/skill <name>` or `/skill:<name>` to load one explicitly. Use `/promote-user-skill [skill]` to copy stable user-level skills into repo `skills/user/<skill>/` after duplicate checks.

To find and install new skills from the open agent skills ecosystem, use `npx skills find <query>`.
