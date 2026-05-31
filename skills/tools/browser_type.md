---
name: browser-type-guidance
type: tool-guidance
target_tool: BrowserType
priority: 6
token_cost: 80
user-invocable: false
description: Guidance for typing text into interactive browser form inputs.
keywords: [browser, type, form, input, search, submit, selector, interactive]
---
## BrowserType Tool
Fill text into an input element.

REQUIRED: selector (CSS), text
OPTIONAL: submit (bool — press Enter after typing)

RULES:
- For search boxes, use submit=true to execute the search in one call.
- Selector must uniquely identify the input (e.g. `input[name="q"]`).

EXAMPLE:
```tool
{"name": "BrowserType", "input": {"selector": "input[name=\"q\"]", "text": "Alan Turing", "submit": true}}
```
