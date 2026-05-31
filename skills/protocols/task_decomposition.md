---
name: task-decomposition
type: workflow
triggers: ["/decompose"]
when_to_use: when the task has multiple unknowns or clearly requires multi-step reasoning
context: inline
token_cost: 140
user_invocable: false
description: Workflow for decomposing multi-step tasks into knowns, unknowns, and tool steps.
keywords: [decompose, plan, steps, unknown, task, multi-step, workflow]
---
## Task Decomposition

Before taking ANY tool action, reply with a short decomposition:

GIVEN: <one line — what the prompt already states>
UNKNOWN: <one or two items — what you need to find out>
PLAN:
  1. <first tool action, concrete>
  2. <second tool action>
  3. <final answer step>

Rules:
- Keep UNKNOWN to 1–2 items. If it grows past 2, split the task further in step 1.
- Resolve one unknown fully before moving to the next — do NOT interleave.
- After each tool call, check: did this resolve an UNKNOWN? If yes, strike it. If no, revise the PLAN.
