# Conformance

`conformance.yml` is the executable checklist for the Artifact Server product specification. The HTML specification explains the product; the ledger identifies the observable behavior and failure proof required to claim that an implementation conforms.

## Status meanings

- `specified`: the requirement exists, but its normal behavior has not been proved on an applicable deployment.
- `implementing`: implementation work is active, but passing proof is not complete.
- `behavior_verified`: the behavior test (`<ID>-B`) exists and passes in the iteration gate; the failure test is not yet written.
- `verified`: both the behavior test (`<ID>-B`) and the failure test (`<ID>-F`) exist and pass in the iteration gate.
- `blocked`: a named external decision or dependency prevents progress.
- `not_applicable`: the requirement does not apply, with the reason recorded in the ledger.

Do not mark a requirement `verified` because its code exists or one local test passes. `verified` is the release-level state defined above.

## Test IDs

Every requirement owns two acceptance IDs:

- `*-B` proves the documented behavior.
- `*-F` proves the hostile, invalid, or failure case.

Put each implemented acceptance ID in exactly one test title. A single end-to-end test may prove several IDs when one observable workflow genuinely covers them together. Do not attach an ID to a test that proves only a convenient approximation of the requirement.

## MCP release critical path

The official connection paths are release gates, not documentation-only goals:

- `MCP-016`: local `artifactserver connect` and stdio setup without a browser,
  visible key, copied secret, Docker requirement, or startup-log inspection;
- `MCP-013`: team-server `/mcp` connection with OIDC browser approval,
  renewal, revoke, and reconnect;
- `MCP-018`: administration-issued user and service API keys for self-hosted
  fallback, CI, scripts, and unattended agents, with no secret leakage; and
- `MCP-019`: real-client installation and stale-state tests in every advertised
  Codex, Claude Code, Cursor, and VS Code surface.

A deployment cannot be released by passing protocol conformance while failing
its human connection experience.

## Iteration gate

Run the complete gate after every implementation iteration:

```sh
pnpm verify:iteration
```

For focused checks while developing:

```sh
pnpm conformance:validate
pnpm conformance:tests
```

The validator checks ledger structure and status contracts. The test-ID checker rejects unknown or multiply claimed acceptance IDs and verified statuses without their tests.

## Release gate

A release is conformant when `pnpm verify:iteration` passes. `verified` and `behavior_verified` statuses are enforced by `pnpm conformance:tests`. A failed gate is a product status, not a reason to weaken the ledger or its tests.
