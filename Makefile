.DEFAULT_GOAL := verify

.PHONY: help verify coverage check migrate install update patch minor major

verify:
	bun verify

check:
	bun check

coverage:
	bun coverage

migrate:
	bun migrate

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

help:
	@printf '%s\n' \
		'Available targets:' \
		'  verify    Run checks and tests' \
		'  check     Run non-mutating lint and type-check' \
		'  coverage  Run checks and tests with coverage' \
		'  migrate   Run Biome migrations' \
		'  install   Install dependencies' \
		'  update    Update dependencies' \
		'  patch     Bump patch version and publish to npm' \
		'  minor     Bump minor version and publish to npm' \
		'  major     Bump major version and publish to npm'
