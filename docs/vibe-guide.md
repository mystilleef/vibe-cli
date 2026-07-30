# Vibe Skills

**`vibe-check`**—Invoke before execution when the plan involves any of:

- irreversible operations
- external side effects (API calls, email, payment, destructive writes)
- ambiguous scope or flagged uncertainty
- multi-step chains with partial-failure risk

- Skip for reversible, single-step work
- Execute only the final approved returned `plan`; never the original

**`vibe-learn`**—Invoke after any concrete outcome; classify as one of:

- `mistake`—something went wrong; a better action exists
- `success`—an approach worked and should repeat
- `preference`—user expressed a durable constraint or preference

- Skip generic, context-only, or in-session-only observations
- One entry per outcome only

**`vibe-constitution`**—Invoke when any condition holds:

- User states a constraint, safety rule, or preference persisting across
  checks
- Task carries irreversible operations or persistent risk boundaries
- Session resumed with potentially stale constitution rules
- Existing rules conflict with the current task or user direction

- Inspect rules before any mutation
- Keep rules atomic; don't stack replacement rules
