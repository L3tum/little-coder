---
name: browser-click-guidance
type: tool-guidance
target_tool: BrowserClick
priority: 7
token_cost: 90
user-invocable: false
description: Guidance for clicking elements in the interactive browser by role or selector.
keywords: [browser, click, button, link, selector, aria, interactive, navigate]
---
## BrowserClick Tool
Click an element by CSS selector OR by ARIA role+name.

RULES:
- Prefer role+name over CSS selectors when the element has an accessible name.
- Never click without first extracting the page — you need to know what links exist.
- If the click fails with "Error clicking", the selector was probably wrong; extract and choose a different target rather than guessing again.

EXAMPLE (role+name):
```tool
{"name": "BrowserClick", "input": {"role": "link", "name": "Edit this page"}}
```

EXAMPLE (CSS):
```tool
{"name": "BrowserClick", "input": {"selector": "a.external"}}
```
