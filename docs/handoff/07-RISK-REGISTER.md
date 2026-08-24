# Risk Register and Non-Negotiable Mitigations

| Risk | Required mitigation | Never do |
|---|---|---|
| Duplicate downloads after retry/restart | Transactional idempotency, durable external correlation key, stage-aware retry | Blindly resubmit an unknown job |
| Untrackable torrent/NZB | Preflight correlation identity; use `needs_attention` on accepted NZB without ID | Pretend a title is a job identity |
| Partial book visible to ABS | Stable-tree check; atomic rename or hidden verified copy then rename | Copy directly into a visible final folder |
| Path escape or malicious archive tree | `realpath` root confinement, reject symlinks/special files, explicit mappings | Trust a provider-supplied path |
| Wrong imported item opened | Exact path or unique strong evidence; ambiguity → `needs_attention` | Select title-only or first match |
| Credential disclosure | Server-only secrets, token fingerprints, structured redaction tests | Return raw upstream bodies or URLs |
| Gateway 401 logs user out of ABS web | Independent acquisition error handling | Clear/refresh ABS session due solely to gateway failure |
| ABS upstream divergence | Runtime schemas and adapter compatibility tests | Patch ABS server for convenience |
| Next.js/Capacitor mismatch | Separate local Vite mobile app sharing contracts/API behavior | Static-export the Next app or set remote `server.url` |
| Mobile process death | Native secure session, persistent player/download state without token | Store tokens in localStorage/player database |
| Production media damage | Disposable volume journey and explicit production enablement gate | Run tests against a production library |
| Overnight scope overreach | Dependency gates and truthful status file | Claim unrun physical/signing/deployment checks passed |

## Known integration edge cases already answered

- Same-origin cookies work because the React host writes an `access_token` cookie scoped to `/`; the gateway reads it and validates it against ABS. If the deployed app uses a narrower cookie path, the proxy route must be placed inside that path or the React host must explicitly proxy the gateway request. Do not make the cookie readable by client JavaScript.
- ABS and gateway container paths can differ. Prefer an explicit path-prefix translation configuration if exact-path resolution is needed. Do not infer host paths.
- An ABS library scan requires an administrative token; user acquisition permission does not grant the client that token.
- Cancellation is best effort for active Librarr work. It never deletes an already imported book and never removes unrelated provider data.
- Staging is disposable only after the gateway has durably recorded and verified the final handoff.

