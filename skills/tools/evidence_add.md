---
name: evidence-add-guidance
type: tool-guidance
target_tool: EvidenceAdd
priority: 10
token_cost: 100
user-invocable: false
description: Guidance for saving citable evidence snippets before making factual claims.
keywords: [evidence, cite, citation, source, fact, research, claim, snippet]
---
## EvidenceAdd Tool
Save a short citable snippet. Every fact you will put in your final answer must come from an evidence entry.

REQUIRED: source (URL or identifier), note (1-line summary), snippet (<=1KB of exact text)

RULES:
- Save the SMALLEST span that supports the claim. Don't dump a paragraph when one sentence is enough.
- One note = one claim. If a page has three useful facts, store three entries.
- Snippet must be verbatim from the source, not paraphrased.
- The returned id is what you cite in your final answer (e.g. `per e3a1f2`).

EXAMPLE:
```tool
{"name": "EvidenceAdd", "input": {"source": "https://en.wikipedia.org/wiki/Turing_machine", "note": "Turing machine introduced in 1936", "snippet": "The Turing machine was invented in 1936 by Alan Turing."}}
```
