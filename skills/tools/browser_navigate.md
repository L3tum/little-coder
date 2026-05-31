---
name: browser-navigate-guidance
type: tool-guidance
target_tool: BrowserNavigate
priority: 8
token_cost: 80
user-invocable: false
description: Guidance for navigating the interactive browser to complete HTTP or HTTPS URLs.
keywords: [browser, navigate, url, website, interactive, page, http, https]
---
## BrowserNavigate Tool
Load a URL in the shared browser page.

REQUIRED: url (http:// or https://)

RULES:
- After navigating, ALWAYS call BrowserExtract before BrowserClick. You need the page text to decide what to click.
- URL must be complete with protocol.
- Do not navigate the same URL twice in a row; use BrowserBack or scroll instead.

EXAMPLE:
```tool
{"name": "BrowserNavigate", "input": {"url": "https://en.wikipedia.org/wiki/Turing_machine"}}
```
