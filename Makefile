# Little Coder — Makefile

# Default target: run the full check pipeline
.PHONY: all
all: format lint typecheck test

# ── Formatting ──────────────────────────────────────────────────────────────

.PHONY: format fmt
format fmt:
	node_modules/.bin/prettier --write .

# ── Linting ─────────────────────────────────────────────────────────────────

.PHONY: lint
lint:
	node_modules/.bin/eslint . --ext .ts,.mts,.cts,.mjs,.cjs --no-error-on-unmatched-pattern

# ── Type Checking ───────────────────────────────────────────────────────────

.PHONY: typecheck
typecheck:
	node_modules/.bin/tsc --noEmit

# ── Testing ─────────────────────────────────────────────────────────────────

.PHONY: test
test:
	node_modules/.bin/vitest run

# Python benchmarks (optional)
.PHONY: test\:py
test\:py:
	python3 -m pytest benchmarks/test_rpc_client.py -q

# ── Clean ────────────────────────────────────────────────────────────────────

.PHONY: clean
clean:
	rm -rf node_modules

# ── Development ──────────────────────────────────────────────────────────────

.PHONY: start
start:
	npm start

# ── Install ──────────────────────────────────────────────────────────────────

.PHONY: install
install:
	npm install

# ── Help ─────────────────────────────────────────────────────────────────────

.PHONY: help
help:
	@echo "Targets:"
	@echo "  all        Run format, lint, typecheck, and test"
	@echo "  format/fmt Format code with Prettier"
	@echo "  lint       Lint code with ESLint"
	@echo "  typecheck  TypeScript type checking"
	@echo "  test       Run vitest tests"
	@echo "  test:py    Run Python benchmark tests"
	@echo "  clean      Remove node_modules"
	@echo "  start      Start the application"
	@echo "  install    Install dependencies"
