# Devbox attention recovery prototype

Interactive prototype **0.7**, paired with the [English PRFAQ 0.8](../../docs/devbox/PRFAQ-v0.8.en.md). The interface remains in Chinese. All sessions, machines, PRs, artifacts, deliveries, and permissions are fictional local examples. The prototype does not connect to agents or production systems.

## Run locally

Use Node.js 22 or later and npm.

```sh
cd prototypes/devbox-attention
npm ci
npm run dev -- --port 4175
```

Open http://127.0.0.1:4175/. The development server binds to loopback by default. The prototype is separate from the production `web/` application.

## Build and check

```sh
npm run build
npm test
```

Build first: the worker packaging tests inspect the generated files. The output includes `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`. The existing Sites adapter is retained; nothing is published by these commands. `npm run test:sites` runs the worker and packaging tests alone.

## Suggested walkthrough

1. Open the API retry work item. Recover the goal, prior stopping point, original rationale, updated constraint, and source excerpts.
2. Open the editable repair draft. Use the footer scenario menu to change the attempt limit after saving. Each conflicting sentence can be updated separately or explicitly kept as a historical comparison.
3. Add your own text, undo a local correction, and refresh. Check that unrelated edits survive and unchanged evidence does not ask for repeated acknowledgment.
4. Open investigation separately from repair. A new unsent question stays separate from earlier receipts. Simulate a channel without read-only restrictions: the fallback displays local records and says the question is not yet verified; it does not claim original-agent delivery.
5. Explicitly submit repair to the original simulated session. Distinguish sending, delivered, accepted, and waiting. Simulate failure to check draft preservation and retry.
6. Simulate a new result and inspect its version-bound log and diff. Accepting the result records a decision; it does not merge a PR.
7. Load an incorrect association, separate it, and undo. New sessions show an association preview and remain separate when the work identity is uncertain.

Drafts and corrections persist in this browser. Reset or clearing browser data removes them. No real extraction, semantic reasoning, cross-device sync, permission enforcement, billing, or delivery is implemented.

## Evidence boundary

Round eight used the same simulated prospective user selecting actions from screenshots and accessibility output while the main agent operated the browser. The initial run covered local edits and final handoff. Post-fix checks were targeted state checks, not a complete final end-to-end replay. See [review evidence](../../docs/devbox/evidence/README.md).

The code is deterministic demonstration logic. Automated tests verify selected state and packaging contracts, not real agent permissions, semantic coverage, user time savings, or willingness to pay.
