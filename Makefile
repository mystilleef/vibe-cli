.DEFAULT_GOAL := verify

.PHONY: help verify coverage check migrate install update

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

help:
	@printf '%s\n' \
		'Available targets:' \
		'  verify    Run checks and tests' \
		'  check     Run non-mutating lint and type-check' \
		'  coverage  Run checks and tests with coverage' \
		'  migrate   Run Biome migrations' \
		'  install   Install dependencies' \
		'  update    Update dependencies'
