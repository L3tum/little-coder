---
name: find-read-guidance
type: tool-guidance
target_tool: findRead
priority: 10
token_cost: 120
user-invocable: false
---
## findRead Tool
Find files matching a glob pattern and read their contents in one call. Combines Glob + Read so you don't need two separate tool calls.

REQUIRED: pattern (glob pattern like "**/*.py")
OPTIONAL: path (base directory, defaults to cwd), maxFiles (default 5, max 50), maxCharacters per file (default 4000, 0 = unlimited)

RULES:
- Use ** for recursive matching across directories
- Returns each file's absolute path followed by its content, separated by headers
- **Always use conservative limits** — this tool can easily overload the context window
- Default maxFiles is 5 and default maxCharacters is 4000; increase only when needed
- Never use maxFiles > 10 or maxCharacters > 10000 without a specific reason
- Paths are resolved relative to the `path` argument or cwd

WHEN TO USE findRead:
- You need to discover files AND read them (the common Glob → Read pattern)
- You want to inspect several files matching a pattern without multiple tool calls
- You need a quick overview of a directory's contents

WHEN TO USE Glob INSTEAD:
- You only need the file paths, not their contents
- You want to pick specific files to read one at a time
- The glob might match many files and you only need to see names

WHEN TO USE code_search INSTEAD:
- You're looking for where a function/class/variable is defined
- You want to know what calls a function or what a function calls
- You need structural code navigation (call graph, type hierarchy, references)

EXAMPLE (conservative — preferred):
```tool
{"name": "findRead", "input": {"pattern": "**/*.py", "maxFiles": 3, "maxCharacters": 4000}}
```

EXAMPLE (with character limit):
```tool
{"name": "findRead", "input": {"pattern": "src/**/*.ts", "path": "/home/user/project", "maxFiles": 5, "maxCharacters": 8000}}
```
