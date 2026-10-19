# Prototype guidance

This is a standalone fictional UX prototype, separate from the production web app. Keep changes scoped here unless explicitly asked to integrate them.

- Preserve original session identity, visible provenance, reversible local grouping, and local draft recovery.
- Separate user decisions, agent suggestions, historical evidence, investigation, repair authorization, and result acceptance.
- Resolve conflicting draft sentences locally. Undo must preserve later unrelated edits. Do not repeat confirmation for unchanged evidence.
- Keep each inquiry and receipt tied to its own question, target, time, and channel. A local lookup must not erase pending remote state or claim an answer it has not produced.
- All permissions and remote actions are simulated. Do not connect real systems or represent demo receipts as real deliveries.
- Use fictional sample names and paths. Do not copy personal records, private hosts, or screenshots into the package.
- Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` compatible. Run `npm run build` before `npm test` because packaging tests inspect generated artifacts.
- UI strings are Chinese; the product PRFAQ is available in English under `docs/devbox/`.
