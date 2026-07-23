# `/btw` side questions (P3-16)

Mid-session aside that does **not** cancel or steer the main turn — distinct from
Steer (`_x.ai/interject`, #52).

## Wire (grok 0.2.111)

| | |
|---|---|
| Method | `_x.ai/btw` (bare `x.ai/btw` → `-32601` at decode) |
| Params | `{ sessionId, question }` — `text` / `prompt` / `message` → `-32602` |
| Result | `{ result: { answer: string } }` (double-wrapped; see below) |
| Stream | Answer is **not** `agent_message_chunk` on the parent session |
| Persist | `btw_history.jsonl` in the session dir |

Example (idle):

```jsonc
// →
{ "method": "_x.ai/btw", "params": {
  "sessionId": "019f…",
  "question": "What is 2+2? Reply with one number only."
}}
// ←
{ "result": { "result": { "answer": "4" } } }
```

`btw_history.jsonl` line:

```json
{"btwSessionId":"btw-…","parentSessionId":"019f…","askedAt":"…Z",
 "question":"…","answer":"4","model":"grok-4.5","success":true}
```

## Mid-turn non-interference

Probed with a live "count 1..40" turn: `_x.ai/btw` accepted mid-stream, returned
`answer:"4"`, and the main turn still ended `end_turn` with the full count +
`DONE`. No cancel, no course change (unlike interject).

## Extension behavior

- Composer `/btw <question>` (idle **or** busy) → host `btwSend` → `_x.ai/btw`
- Does **not** set main-turn busy, does **not** queue or steer
- Renders a dedicated aside card (question + answer / pending / error)
- `-32601` → clear "needs newer CLI" error on the card
- Empty `/btw` → usage hint, no RPC

## Probe

```bash
node research/btw-probe.cjs            # idle shape hunt
node research/btw-probe.cjs --mid-turn # non-interference
```
