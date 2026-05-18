.DEFAULT_GOAL := verify

.PHONY: help verify coverage check fix migrate install update patch minor major

help:
	@printf '%s\n' \
		'Available targets:' \
		'  verify    Run checks and tests' \
		'  coverage  Run checks and tests with coverage' \
		'  check     Run non-mutating lint and type-check' \
		'  fix       Fix lint and formatting issues' \
		'  migrate   Run Biome migrations' \
		'  patch     Bump patch version and publish to npm' \
		'  minor     Bump minor version and publish to npm' \
		'  major     Bump major version and publish to npm'

migrate:
	bun migrate

check:
	bun check

fix:
	bun fix

verify:
	bun verify

coverage:
	bun coverage

install:
	bun install

update:
	bun update --latest

patch:
	bun run release -- patch

minor:
	bun run release -- minor

major:
	bun run release -- major
