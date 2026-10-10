---
name: responsibility-stack
description: Onboard a Git repository for AI responsibility tracking, trace why code changed, compare or restore a signed feature checkpoint, verify evidence, or safely roll back an attributable change.
---

# ResponsibilityStack

Use the ResponsibilityStack MCP tools only when the user asks about change provenance, responsibility, unexpected behavior drift, evidence integrity, or rollback. Do not query history during ordinary coding.

Always pass the current Git repository path to MCP tools. Prefer compact history or `responsibility_why`; do not load stored source snapshots into the conversation unless they are required to resolve a specific conflict.

When the user asks to initialize, adopt, or onboard an existing repository, call `responsibility_onboard`. Report whether it is ready and how many pre-existing changed paths were excluded from attribution. Tracking starts at onboarding; never imply that earlier AI history was reconstructed. Do not create feature checkpoints automatically.

For feature drift:

1. When the user explicitly says a feature currently works or asks to remember its current state, call `responsibility_feature_checkpoint` with the smallest explicit paths that define it. Never create checkpoints automatically.
2. When the user says a feature used to work, call `responsibility_feature_list`, then `responsibility_feature_status` or `responsibility_feature_history` before considering rollback.
3. A checkpoint proves the captured source state and the user's known-good declaration. Do not claim it proves runtime behavior unless separate test evidence exists.

For feature recovery, call `responsibility_rollback_plan` with `kind: feature` first. The plan must reject unattributed drift and report affected files, hunks, and code symbols. Call `responsibility_rollback` only after the user explicitly asks to apply it. If exact recovery is blocked by later edits, report the conflict and use event-level hunk or symbol rollback only when the user requests that narrower recovery.

For rollback:

1. Call `responsibility_rollback_plan` first and report conflicts or affected paths.
2. Call `responsibility_rollback` only when the user explicitly requested that mutation.
3. Preserve the reported recovery kind: `exact` restores a matching recorded state; `transplanted` applies an independent historical hunk or symbol. Never describe transplanted recovery as exact history.

If evidence verification fails, stop and report the failure instead of using that evidence for rollback.
