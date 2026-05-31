---
name: cite-before-answer
type: workflow
triggers: ["/cite"]
when_to_use: always, before producing a final answer on a research task
context: inline
token_cost: 120
user_invocable: false
description: Checklist for citing saved evidence before final answers on research tasks.
keywords: [cite, citation, evidence, final answer, research, source]
---
## Cite-before-answer checklist

Before typing your final answer, run this check internally:

1. Call EvidenceList. Confirm it is non-empty.
2. For each claim in your planned answer, identify the evidence id(s) that support it.
3. If any claim has no id → either remove the claim, or go gather one more piece of evidence.
4. Prefix your final answer with `Citations: e1, e2, …` listing the ids you used.

A final answer with zero citations is invalid on research tasks. Do not guess.
