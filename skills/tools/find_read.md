---
name: find-read-guidance
type: tool-guidance
target_tool: FindRead
priority: 10
token_cost: 120
user-invocable: false
---
## FindRead Tool
Find files matching a glob pattern and read their contents in one call. Combines Glob + Read so you don't need two separate tool calls.

REQUIRED: pattern (glob pattern like "**/*.py")
OPTIONAL: path (base directory, defaults to cwd), maxFiles (default 10, max 50), maxLines per file (default 200, 0 = unlimited)

RULES:
- Use ** for recursive matching across directories
- Returns each file's absolute path followed by its content, separated by headers
- Use maxFiles to avoid flooding context when a glob matches many files
- Use maxLines to cap large files; set to 0 for no limit
- Paths are resolved relative to the `path` argument or cwd

WHEN TO USE FindRead:
- You need to discover files AND read them (the common Glob → Read pattern)
- You want to inspect several files matching a pattern without multiple tool calls

WHEN TO USE Glob INSTEAD:
- You only need the file paths, not their contents
- You want to pick specific files to read one at a time

EXAMPLE:
```tool
{"name": "FindRead", "input": {"pattern": "**/*.py", "maxFiles": 5}}
```

EXAMPLE with line limit:
```tool
{"name": "FindRead", "input": {"pattern": "src/**/*.ts", "path": "/home/user/project", "maxFiles": 20, "maxLines": 100}}
```
