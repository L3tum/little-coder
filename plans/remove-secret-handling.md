# Remove "[REDACTED]" Secret Handling from Security and Filter-Read Extensions

## Context
Two extensions handle "[REDACTED]" secret masking:

1. **`security/index.ts`** — exports `SECRET_PATTERN` and `containsSecret` to detect secrets, but this is never used by the extension's `tool_call` handler. Dead code.

2. **`filter-read/index.ts`** — intercepts tool output and replaces secrets (API keys, tokens, passwords, private keys, connection strings) with `[REDACTED]`-style placeholders (e.g., `[OPENAI_KEY_REDACTED]`, `[REDACTED]`). This is the actual secret redaction that "confuses the Agent unnecessarily".

The user wants all "[REDACTED]" secret handling removed. Since `filter-read/index.ts` contains only secret redaction logic, the entire file can be deleted. The security extension just needs its unused dead code removed.

## Approach
- **`security/index.ts`**: Remove the unused `SECRET_PATTERN` export and `containsSecret` function.
- **`filter-read/index.ts`**: Delete the entire file, since it only performs secret redaction and file blocking — both of which rely on "[REDACTED]" strings.

## Files to modify
- `.pi/extensions/security/index.ts` — remove lines 6-10 (`SECRET_PATTERN` + `containsSecret`)
- `.pi/extensions/filter-read/index.ts` — delete the entire file

## Steps
- [ ] Remove `SECRET_PATTERN` and `containsSecret` from `security/index.ts`
- [ ] Delete `.pi/extensions/filter-read/index.ts`
- [ ] Confirm no other code references `filter-read` or its exports

## Verification
- Run `grep containsSecret .pi` to verify no usage
- Run `grep SECRET_PATTERN .pi` to verify no usage
- Run `grep filter-read .pi` to verify no references
- Run `grep REDACTED .pi` to confirm all "[REDACTED]" strings are gone
