---
name: bash-guidance
type: tool-guidance
target_tool: bash
priority: 10
token_cost: 120
user-invocable: false
---
## Bash Tool
Execute a shell command and return stdout+stderr.

REQUIRED: command (shell command string)
OPTIONAL: timeout (seconds, default 30 - use 120-300 for installs/builds), cwd (working directory under current workspace; defaults to current working directory)

RULES:
- Stateless: each call starts fresh
- Prefer `cwd` over `cd /path && ...`
- Prefer `glob` / `read` / `findRead` over bash for simple file listing and file reads
- Use timeout=120 for: pip install, npm install, builds, downloads
- Returns combined stdout and stderr

EXAMPLE:
```tool
{"name": "bash", "input": {"command": "ls -la", "cwd": "/path/to/project"}}
```

EXAMPLE with timeout:
```tool
{"name": "bash", "input": {"command": "pip install requests", "timeout": 120}}
```
