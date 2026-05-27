# Planning mode

Use `/plan` to enter planning mode. This is the canonical command.

`/plannotator` is retained only as a compatibility shim for existing users and invokes the same handler as `/plan`.

## Interactive workflow

In planning mode the agent should research before proposing changes:

- Prefer `code_search` and `lsp` for codebase navigation.
- Use `findRead` or targeted `read` only after narrowing scope.
- Use `websearch`/`webfetch` for external package, API, or tool-choice research.
- Use `EvidenceAdd` for facts that the final plan cites.
- Use `ask_user` for unresolved user decisions after research; if unavailable, ask plain end-of-turn questions.

The agent writes a markdown plan and submits it for browser review. After approval, normal execution can proceed.

## Issue-agent clarification workflow

Issue-agent PLANNING uses the same planning guidance, but it cannot use the interactive TUI `ask_user` tool. Instead, planning sub-agents use `issueAgentAsk` with:

- `question` or `questions`
- optional `choices`
- `context`: all prior context needed to resume later

The harness posts the question, choices, and context as an issue comment and keeps the issue in `ai:state/WAITING_FOR_FEEDBACK`. It does not busy-wait or retry the same planning sub-agent.

A human replies with:

```text
/answer the requested decision or details
```

On the next polling cycle, issue-agent detects the latest unanswered `/answer ...`, finds the preceding issue-agent ask comment, switches the issue back to `ai:state/PLANNING`, and resumes planning with both the captured answer and stored context.
