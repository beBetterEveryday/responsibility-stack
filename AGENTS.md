# ResponsibilityStack engineering rules

- Default recording must add zero tokens to the wrapped coding-agent session.
- Plugin hooks are the default capture path; the CLI wrapper is compatibility-only.
- Hook output stays empty on success so evidence collection never enters model context.
- Record each user turn as one signed responsibility run and attach edits to observed tool calls.
- Runtime evidence lives under `.git/respstack`; never generate per-run files in the working tree.
- Repository onboarding is idempotent, records the tracking start, and never attributes pre-existing changes.
- Feature checkpoints are explicit user-declared known-good states; never create them automatically.
- Feature recovery requires a verified, continuous responsibility chain from the checkpoint and must reject unattributed drift.
- Redact common secrets before persisting prompt text while retaining a digest of the original intent.
- Record observed facts separately from later AI interpretation.
- Never equate an observing session or a valid signature with proven authorship; expose attribution and observer context separately.
- Onboarding storage readiness and observed hook health are separate states; never claim active capture from store initialization alone.
- Rollback fails closed when current content no longer matches its recorded precondition.
- Label recovery as exact, transplanted, or reconstructed; never present reconstruction as history.
- Prefer Node standard-library features and deterministic local processing over services or model calls.
- Every non-trivial recorder or rollback change needs a focused executable test.
