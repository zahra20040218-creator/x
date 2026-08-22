# The autonomous loop runs `make test && make lint && make typecheck`
# (AGENT_LOOP_PROMPT.md step 3), so those three targets are the contract.
#
# `make` is not installed on the Windows host this repo was bootstrapped on.
# Every target below has an identical pnpm script (`pnpm test`, `pnpm lint`,
# `pnpm typecheck`) so the same commands are runnable with or without make.
# If you change a target here, change the matching script in package.json.

.PHONY: help install test test-unit test-integration test-e2e lint typecheck \
        coverage migrate migrate-down seed up down logs clean flutter-test verify

help:
	@echo "install          - install all workspace dependencies"
	@echo "test             - full backend suite with coverage thresholds"
	@echo "test-unit        - unit tests only (no Docker needed)"
	@echo "test-integration - tests that need real Postgres + Redis (needs 'make up')"
	@echo "lint             - eslint across the workspace"
	@echo "typecheck        - tsc --noEmit, strict"
	@echo "coverage         - coverage report, enforces CLAUDE.md 10 thresholds"
	@echo "up / down        - start / stop the local stack"
	@echo "migrate          - apply forward migrations"
	@echo "flutter-test     - Flutter tests (requires the Flutter SDK)"
	@echo "verify           - what the loop's self-check runs"

install:
	pnpm install --frozen-lockfile

test:
	pnpm -r test

test-unit:
	pnpm --filter @rideapp/api test:unit

test-integration:
	pnpm --filter @rideapp/api test:integration

test-e2e:
	pnpm --filter @rideapp/api test:e2e

lint:
	pnpm -r lint

typecheck:
	pnpm -r typecheck

coverage:
	pnpm --filter @rideapp/api coverage

migrate:
	pnpm --filter @rideapp/api migrate:up

migrate-down:
	pnpm --filter @rideapp/api migrate:down

seed:
	pnpm --filter @rideapp/api seed

up:
	docker compose -f infra/docker-compose.yml up -d

down:
	docker compose -f infra/docker-compose.yml down

logs:
	docker compose -f infra/docker-compose.yml logs -f --tail=200

clean:
	rm -rf node_modules services/api/node_modules services/api/dist apps/admin/node_modules apps/admin/dist coverage

# Flutter is a separate toolchain; it is intentionally NOT part of `make test`,
# because `make test` must stay runnable on a machine that has only Node.
flutter-test:
	cd packages/core && flutter test
	cd apps/rider && flutter test
	cd apps/driver && flutter test

verify:
	@$(MAKE) test
	@git status --short
	@echo "[x]       : $$(grep -c '^- \[x\]' TASKS.md)"
	@echo "[ ]       : $$(grep -c '^- \[ \]' TASKS.md)"
	@echo "[BLOCKED] : $$(grep -c 'BLOCKED' TASKS.md)"
