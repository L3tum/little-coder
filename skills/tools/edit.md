---
name: edit-guidance
type: tool-guidance
target_tool: edit
priority: 10
token_cost: 150
user-invocable: false
---
## Edit Tool
Replace exact text in a file. This is the **default tool for changing any existing file** — prefer it over Write for anything except creating a new file from scratch.

REQUIRED: path (absolute), edits (array of {old_string, new_string})
OPTIONAL: none

RULES:
- Each `old_string` must match EXACTLY (whitespace, indentation, line endings all matter)
- Each `old_string` must be unique in the file — include 2-3 lines of surrounding context if needed
- `edits` is matched against the **original** file, not after earlier edits apply — do not overlap or nest
- To delete text: set `new_string` to ""
- Read the file first if you do not already have its current content
- Batch multiple disjoint changes in one call by passing multiple `edits[]` entries

EXAMPLE (single change):
```tool
{"name": "edit", "input": {"path": "/absolute/path/file.py", "edits": [{"old_string": "def hello():\n    return 1", "new_string": "def hello():\n    return 2"}]}}
```

EXAMPLE (two changes in one call):
```tool
{"name": "edit", "input": {"path": "/absolute/path/file.py", "edits": [{"old_string": "MAX = 10", "new_string": "MAX = 20"}, {"old_string": "TIMEOUT = 5", "new_string": "TIMEOUT = 30"}]}}
```

RECOVERY WHEN Edit FAILS:
- "String not found" → Read the file to get the exact current content (whitespace often differs), then retry Edit with the exact string
- "Found multiple times" → include more surrounding context so `old_string` is unique, then retry Edit
- Do NOT fall back to write just because edit failed once — re-read, fix `old_string`, retry. write is almost always the wrong recovery here for an existing file.
