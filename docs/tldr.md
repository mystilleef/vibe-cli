# vibe

> Task-first mentor review cheat sheet for the vibe CLI: check plans with a mentor before risky work.
> Run `vibe --help` for every command and `vibe <command> --help` for command-specific help.

- Install the settings template (requires provider configuration and an API key):

`vibe settings install`

- Verify provider connectivity:

`vibe verify`

- Install skills to an explicit harness target (default: ~/.agents/skills):

`vibe skills install --target ~/.claude/skills`

- Install the guide into the current directory:

`vibe guide install`

- Run the live walkthrough:

`vibe demo`

- Show a stored-data overview:

`vibe list all`

- Filter learnings by type, such as mistake:

`vibe list learnings --type mistake`

- Review a plan against a goal (exit 2 means no-proceed):

`vibe check --goal "{{goal}}" --plan "{{steps}}"`

- Run read-only local diagnosis:

`vibe doctor`

- Report duplicate learnings:

`vibe prune --duplicates`

- Delete duplicate learnings after one safety backup:

`vibe prune --duplicates --yes`

- Print diagnostic results as JSON:

`vibe doctor --json`
