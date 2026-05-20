---
name: read-edit-verify-guidance
type: tool-guidance
target_tool: readEditVerify
priority: 10
token_cost: 130
user-invocable: false
---
## ReadEditVerify Tool
Read a file, apply text replacements in place, write back, and verify — all in one call. Combines Read + Edit + Verify so you don't need multiple tool calls.

REQUIRED: path (file to edit), replacements (array of {old_string, new_string})
OPTIONAL: none

RULES:
- Each `old_string` must match EXACTLY (whitespace, indentation, line endings all matter)
- Replacements are applied sequentially in order — later replacements operate on the output of earlier ones
- If `old_string` is not found, that replacement is skipped (reported in output)
- After writing, the tool reads back the file and confirms content matches — reports OK or MISMATCH
- The file must already exist (this edits in place, it does not create new files)

WHEN TO USE readEditVerify:
- You want to edit a file and confirm the write succeeded in a single step
- You have multiple replacements to apply and want atomic read-edit-verify
- You want built-in verification without a separate Read call after editing
- **Prefer this over Read + Edit + Read** — it saves two tool calls and reduces context usage

WHEN TO USE Edit INSTEAD:
- You already have the file content and don't need the read step
- You want to use the standard Edit tool's diff output
- You're doing a single simple replacement and don't need verification

EXAMPLE (single replacement):
```tool
{"name": "readEditVerify", "input": {"path": "/absolute/path/file.py", "replacements": [{"old_string": "MAX = 10", "new_string": "MAX = 20"}]}}
```

EXAMPLE (multiple replacements):
```tool
{"name": "readEditVerify", "input": {"path": "/absolute/path/file.py", "replacements": [{"old_string": "MAX = 10", "new_string": "MAX = 20"}, {"old_string": "TIMEOUT = 5", "new_string": "TIMEOUT = 30"}]}}
```
