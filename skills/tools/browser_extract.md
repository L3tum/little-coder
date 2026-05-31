---
name: browser-extract-guidance
type: tool-guidance
target_tool: BrowserExtract
priority: 9
token_cost: 110
user-invocable: false
description: Guidance for extracting readable text from the current interactive browser page.
keywords: [browser, extract, page, read, markdown, cursor, citation, interactive]
---
## BrowserExtract Tool
Return readable markdown of the current page, chunked at ~2KB.

OPTIONAL: cursor (char offset, default "0")

RULES:
- First call: use cursor="0" (or omit).
- The response ends with `[cursor=N next=M total=T has_more=true]`.
  If has_more=true, call again with cursor=M to get the next chunk.
- When you find the span you want, save it via EvidenceAdd immediately — do not rely on remembering it across turns.
- If the page is mostly boilerplate (nav/footer), scroll into the article section first (BrowserScroll) before extracting.

EXAMPLE:
```tool
{"name": "BrowserExtract", "input": {"cursor": "0"}}
```
