# ResponsibilityStack

[简体中文](README.zh-CN.md) | English

> Archived on 2026-10-10. Development and maintenance have stopped. This repository is a public source backup of an experimental project. The final fixes passed 32 automated tests locally; installation and capture inside a real Codex client were not validated.

**Trace responsibility, not blame.**

ResponsibilityStack records code changes observed during AI turns, separates tool-correlated changes from unverified authorship, preserves signed local evidence and known-good feature states, and supports guarded, fine-grained recovery.

## Default integration

ResponsibilityStack is a Codex plugin:

- **Hooks capture automatically.** `UserPromptSubmit` opens a turn baseline, `PostToolUse` records working-tree observations, and `Stop` signs changed turns. Successful hooks remain silent.
- **MCP answers on demand.** History, feature comparison, verification, rollback planning, and rollback are exposed as compact tools.
- **The Skill only routes relevant requests.** Ordinary coding does not query history or add ResponsibilityStack context.
- **The CLI wrapper remains compatible**, but is no longer the recommended entry point.

Once the plugin is installed and its hooks are trusted, keep using Codex normally. No command prefix is required.

## One-command onboarding

From an existing Git repository:

```bash
respstack onboard
```

The command is idempotent. It creates the signed local evidence store, records the onboarding time, identifies pre-existing changed paths as unattributed, and verifies existing evidence. It does not modify or snapshot business source files. `respstack init` remains an alias.

Initialization is not proof that capture is active. The report separates `storageReady` from `capture.status`; `ready` is true only with valid evidence and a signed receipt of a complete `UserPromptSubmit → PostToolUse → Stop` lifecycle observed in the last 15 minutes. The receipt timestamp is shown and is not a guarantee that the plugin remains enabled. Missing, stale, or invalid receipts never report capture as ready.

After installing/enabling and trusting the plugin hooks, complete a Codex turn with a read-only `Read` or `Bash` tool call, then run `respstack onboard --json` again. This checks the hook route without changing source files. The CLI exits successfully when storage initialization/verification succeeds; scripts must inspect `ready` or `capture.status` separately.

Inside Codex, the same flow is exposed as `responsibility_onboard`. Historical AI responsibility before onboarding is not reconstructed.

## Evidence model

Each user turn associates observed edits with:

- the original user intent;
- Codex session and turn ids;
- agent and model;
- tool name and tool-call id;
- timestamp and Git base commit;
- before/after content digests.

These fields describe the observing context, not necessarily the writer. History and MCP responses include an explicit attribution level:

| Level | Meaning |
| --- | --- |
| `tool-correlated` | A supported `Edit`/`Write` input matches the observed path and content transformation, with no overlapping recorded sessions. This is correlation, not provider-certified identity. |
| `unattributed` | Overlapping sessions, shell/wrapper observations, missing tool inputs, or otherwise unverified writers. |
| `declared` | An explicit core API caller declares the before/after change. |
| `system` | ResponsibilityStack's own recovery operation. |

Concurrent sessions share observed file states so a delta is not independently claimed by each session. Agent/model fields for unverified writers are not presented as authors; the observing agent/model is reported separately. Existing capture events without attribution metadata remain readable but are treated as unattributed, without rewriting their signatures. History and explanation queries reject invalid signatures and damaged evidence rather than returning them as facts.

Edit events form a hash chain. Completed turns are signed with a repository-local Ed25519 key. Runtime evidence stays under `.git/respstack`, outside the working tree.

Common secrets, including quoted JSON password/token values, are redacted before prompt text is persisted. A SHA-256 digest of the original prompt is kept for correlation without storing the raw secret. Redaction is best-effort, not a guarantee that arbitrary sensitive text can be detected. Existing signed evidence is not automatically rewritten.

## Known-good feature checkpoints

When a feature is working, explicitly preserve its current source state:

```bash
respstack feature checkpoint login --path src/auth --path test/auth --note "login verified manually"
respstack feature status login
respstack feature history login
respstack rollback feature login --dry-run
respstack rollback feature login
```

A checkpoint is signed, local, and scoped to the smallest files or directories that define the feature. It records observed source state plus the user's known-good declaration; it does not claim runtime proof unless external test evidence exists. Checkpoints are never created automatically.

Feature rollback previews affected files, hunks, and JavaScript/TypeScript symbols, then restores all attributable files as one recoverable transaction. It refuses recovery if the responsibility chain has a gap, contains unattributed observations, or the files changed after the latest recorded event.

## MCP tools

- `responsibility_onboard`: initialize and verify responsibility tracking for a repository.
- `responsibility_history`: compact recent edit history.
- `responsibility_why`: explain who changed a path and why.
- `responsibility_verify`: verify objects, hash chains, and signatures.
- `responsibility_feature_checkpoint`: explicitly save a signed known-good feature state.
- `responsibility_feature_list`: list feature checkpoints.
- `responsibility_feature_status`: compare current files with a checkpoint.
- `responsibility_feature_history`: show attributable edits since a checkpoint.
- `responsibility_rollback_plan`: fail-closed dry run.
- `responsibility_rollback`: apply and record an exact or transplanted rollback.

Rollback supports a known-good feature checkpoint, a complete AI turn, one edit, one diff hunk, or one JavaScript/TypeScript symbol. Exact rollback refuses to overwrite later or unattributed edits.

Safety boundaries:

- Run/feature recovery refuses uncertain authorship. An explicitly selected individual edit, hunk, or symbol can still be restored with an unverified-writer warning and content-conflict checks; this does not establish who wrote it.
- Hunk recovery refuses ambiguous repeated context and implicit relocation when the file has changed since recording. Symbol recovery isolates individual variable declarations; ambiguous symbols and unsupported declaration removal are rejected.
- Source paths containing symbolic links, Git metadata, directories, and duplicate recovery targets are rejected. Symlinks are deliberately unsupported rather than followed or converted silently.
- File changes and signed recovery evidence share a recovery journal. Signing or recording failure restores pre-operation files; a completed signed run is the commit point. On restart, incomplete transactions are recovered and completed transactions are not undone. If files changed manually after interruption, recovery stops and preserves the journal for inspection.
- Locks coordinate ResponsibilityStack operations, not arbitrary external writers. Work in separate Git worktrees when running concurrent agents. These checks are not a sandbox against a hostile process racing filesystem operations, nor a filesystem-level multi-file transaction or a power-loss durability guarantee.

## Cost and project impact

- Recording adds **zero model tokens**: successful hooks emit no model context.
- MCP consumes tokens only when history or rollback is requested.
- Feature checkpoints add work only when explicitly requested; routine turns do not maintain them.
- Hooks run `git status` and hash only changed/touched files instead of snapshotting the repository after every tool call.
- No business source files or generated evidence are added to the working tree.
- A repository only gains local evidence under `.git/respstack`.
- Git-backed blobs and Git listing output have an explicit 64 MiB safety limit; exceeding it fails with a diagnostic instead of silently losing evidence. Ordinary multi-megabyte blobs no longer hit the previous default subprocess-buffer limit.

## Build and validate

Requires Node.js 22 or newer.

```bash
pnpm install
pnpm build
pnpm check
pnpm test
```

`pnpm build` produces self-contained Hook and MCP bundles under `dist/plugin`, so an installed plugin does not need its own `node_modules`.

The initial adapter targets Codex lifecycle hooks. Future Cursor, GitHub Copilot, and OpenCode adapters could feed the same evidence store without changing rollback semantics; those additional adapters are not implemented or validated in this repository.

## Compatibility CLI

For agents without lifecycle hooks:

```bash
respstack onboard
respstack run --intent "Fix login button copy" --agent codex --model model-name -- codex exec "Fix it"
```

Inspection and rollback remain available from the terminal:

```bash
respstack why src/auth/token.ts
respstack history --path src/auth
respstack verify
respstack rollback edit <edit-id> --dry-run
respstack rollback edit <edit-id>
```

Do not combine the wrapper with the installed Hook adapter for the same agent run; wrapped child processes automatically disable plugin capture to prevent duplicate evidence.

## Trust boundary

The local signature proves that stored evidence has not changed since finalization. It does not prove that the machine, operator, or model provider was honest. Provider receipts, workload identity, transparency logs, CI evidence, and deployment links can extend the same evidence model later.
