# Return UX review revision

The goal is to recover context without creating another review queue. These changes refine the production Claude Code workflow; they do not establish a paid-product outcome.

## Scope and cost boundaries

- Automatic grouping is navigation, not authority. The target conversation alone supplies automatically interpreted limits, conflicts, suggestions and rules. A linked migration task cannot replace an HTTP attempt limit, change a saved draft's basis, or block acceptance of the original result.
- Statements beginning with an explicit For/In/On scope and Chinese source messages are kept as source notes rather than interpreted as effective numerical constraints. This is a conservative fallback, not general semantic scope resolution or complete multilingual parsing. Other English scope forms can still require human interpretation.
- An explicit replacement naming an old amount must match an existing amount before replacing it. An unmatched old amount remains a conflict.
- Related-session notes never enter the repair automatically. Uninterpreted notes from the target conversation are included verbatim and dated, with an explicit scope/supersession caveat and an instruction to ask before acting on a conflict. They grant no new permission. The preview digest still protects against sending a message whose basis changed after preview.
- A reason can be recovered from an explicit causal statement without a recognized numeric constraint. Its original wording, author, conversation and time remain available. A historical reason is labeled as such; absence of an extracted reason or limit is not proof of absence.
- The service exposes `questionBudgetUsd`, and uses that same setting for the read-only runner. The UI describes a requested spending limit, not measured cost or independently verified enforcement. Actual usage stays on the answer receipt. Missing budget metadata disables question submission.

## Lower review and switching costs

- The default repair first checks the current revision and reruns relevant checks. It requests repair only if the recorded failure persists. The failure record alone does not prove a present failure.
- Coordinated prohibitions such as “Never merge, push or deploy” retain their negation and full wording. A later positive action remains flagged. This narrow parser correction is not a claim that all natural-language instructions are understood.
- The result view starts with the reply and keeps request-attribution warnings and changed-basis notices visible. Unchanged recorded limits and optional wording comparisons are folded. Matching words are not proof of compliance; counts no longer determine the home badge or acceptance wording.
- Referenced files and artifacts are available beside the result. They are current references, not reply-version snapshots or test attestations. Missing marker or captured test evidence remains visible; accepting is the user's decision.
- A repair reply enters New since you looked, unless a separate recorded blocker needs attention. Delivery uncertainty and held prompts still need attention. Accepted results do not keep resurfacing because of wording-match hints.
- Done for now exits the handoff receipt without accepting or pushing another task. Viewed does not mean accepted or complete.
- Later is a reversible, host/session-scoped choice stored in this browser. Deferred items are collapsed on Now and remain accessible in the work rail. Opening one does not clear deferral. A new agent update or handoff/question state change brings it back. Bring back reverses it manually. There is no scheduled reminder or cross-browser sync.

## Simulated prospective-user retest

The same prospective-user subagent chose actions from screenshots and raw accessibility output; the main agent operated the browser because the subagent's browser surface was unavailable. The app ran its production build against an isolated synthetic host. No real remote agent, paid model call, deployment or merge was involved.

Observed tasks: recover a three-day-old checkout task; distinguish migration constraints from checkout constraints; edit and send to the original mock conversation; inspect its reply; leave without accepting; defer a low-urgency documentation question and find it through Later; inspect Chinese rationale and source notes.

The retest exposed a blocking coordinated-negation bug. The exact original draft was retained, then sent successfully after the parser fix. It also exposed excessive sentence-by-sentence comparison and a misleading “Nothing needs you” label after viewing; both were revised. Source recovery and the one-action deferral/one-click return were useful in this simulation. The participant declined to accept a reply with insufficient evidence. That is a valid exit, not a failed completion funnel.

A final screenshot/accessibility recheck confirmed that optional comparisons are folded, wording-match counts no longer dominate the home badge, and the viewed Chinese task says “Viewed · not accepted”. No new interaction blocker was found in those two screens.

The synthetic host did not supply a real terminal or repository/test output. Real-agent latency, end-to-end test-evidence retrieval, time savings and payment willingness remain unvalidated. One week of real tasks must compare total recovery time, unnecessary checks/clicks, false alerts and correction effort against the user's existing handoff workflow, including sessions the user chooses to leave unresolved.

## Regression coverage

Shared recovery tests cover cross-session contamination, uncertain scope, unmatched replacement amounts, standalone causal rationale, Chinese source preservation, routing-text filtering, and coordinated negation with later positive actions. Service tests cover budget parity and acceptance unaffected by linked constraints. UI tests cover missing-budget refusal, collapsed optional comparisons, neutral result state, deferred attention and explicit return. Existing send, preview, authorization and retry checks continue to run.
