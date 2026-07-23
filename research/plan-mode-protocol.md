# Plan-mode protocol cleanup (P2-13)

Status as of **grok 0.2.111** / extension work 2026-07-23.

## Wire contract (`x.ai/exit_plan_mode`)

JSON-RPC **success** (not error):

```json
{ "outcome": "approved" | "cancelled" | "abandoned", "feedback"?: string }
```

| UI verdict | Wire `outcome` | CLI behavior (0.2.101+) |
|---|---|---|
| Approve | `approved` | Exit plan mode |
| Keep planning / Reject | `cancelled` | Stay in plan; model told user wants revise |
| Cancel / Abandon | `abandoned` | Leave plan mode without implementing |

A JSON-RPC **error** is treated as *client disconnect* (`ext_method_no_client`), not a user verdict — that framing produced the old "exit_plan_mode failed with a client disconnect" model text.

**Re-probe 0.2.111:** `research/oss-surfaces-probe.cjs --scenario=planoutcome` — SUCCESS `{outcome:"cancelled"}` accepted; mode stayed `plan`; model re-entered planning (revise loop). Earlier A/B on 0.2.101: `docs/ACP-feedback.md` §2.1, `research/plan-mode-recheck-probe.cjs`.

Extension mapping: `makeExitPlanResponse` in `src/acp-dispatch.ts`. User card comment → optional `feedback`.

## Client-side plan-gate (kept)

CLI plan mode gates **edit** tools but **not** `terminal/create` (OSS: `plan_mode_edit_gate` only `AccessKind::Edit`; Bash falls through). Until the CLI enforces a read-only shell policy, keep:

- `shouldBlockWrite` — in-workspace `fs/write_text_file`
- `shouldBlockTerminal` — non-allowlisted shell

Pure policy: `src/plan-gate.ts`.

## Primer (kept as hidden prompt)

| Approach | Pros | Cons |
|---|---|---|
| Hidden `session/prompt` (current) | Re-sent on restore + post-`/compact`; versioned marker; proven | Extra silent turn |
| `session/new` `_meta.rules` | No primer turn; sanctioned injection | Applies at create only; **not** proven on `session/load` or after `/compact` history rewrite |

**Decision (P2-13):** keep the prompt primer (v5). Drop obsolete "always approved / do not trust tool result" text; keep `[Plan approved|rejected|cancelled]` action-signal protocol (extension-owned follow-ups). Defer full `_meta.rules` migration until compact + load survival is probe-confirmed.

## Follow-up prompts (unchanged)

After the wire reply, the host still cancels/suppresses the planning-turn tail and sends:

- `[Plan approved]` (+ comment) → implement
- `[Plan rejected]` (+ comment) → refine in plan mode
- `[Plan cancelled]` (+ comment) → leave plan mode

Wire outcome + markers are complementary: outcome is correct CLI-side state; markers drive implement-now and free-form feedback.
