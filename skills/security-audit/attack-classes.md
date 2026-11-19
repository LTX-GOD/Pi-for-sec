# Attack classes

Domain hunting knowledge for block tasks, ported verbatim from Cloudflare's [security-audit-skill](https://github.com/cloudflare/security-audit-skill) (MIT). The copies live in `attack-classes/` untouched; this file is the local routing layer.

This is ammunition for task text, not a pipeline. Your specialist agents are still the dispatch target; these files tell them what to look for in a given domain, and — equally important — what does **not** count as a finding in that domain.

## Routing

| Signal in the block | Read sections from |
|---|---|
| Rust-unsafe / C/C++ / kernel modules / parsers, decoders, FFI, loaders, JIT, firmware | `attack-classes/MEMORY-SAFETY-AND-BINARY.md` |
| LLM in a trust-sensitive decision: chatbot, RAG, agent memory, tool calling, MCP, prompt assembly, model output feeding a sink | `attack-classes/AI-AND-LLM.md` |
| HTTP framing, custom parsers, proxies, sessions, CSRF, JWT, OAuth/OIDC, SAML, MFA, passkeys, account recovery, API keys, mTLS | `attack-classes/WEB-PROTOCOL-AND-AUTH.md` |
| SPAs, browser extensions, webviews, service workers, browser storage, postMessage, CORS, DOM rendering | `attack-classes/CLIENT-SIDE.md` |
| Dependency resolution, CI, release/signing/promotion, updates, plugins, extensions | `attack-classes/SUPPLY-CHAIN-AND-RELEASE.md` |
| IAM, IaC, containers/Kubernetes, mesh, serverless/edge, ingress, provider events, runtime config | `attack-classes/CLOUD-AND-DEPLOYMENT.md` |
| gRPC, GraphQL transports, Protobuf/Cap'n Proto/Thrift, custom protocols, queues, brokers, webhooks, streaming | `attack-classes/PROTOCOLS-RPC-AND-MESSAGING.md` |
| Untrusted work consuming shared CPU/memory/disk/connections/workers/queues/quotas/operator spend | `attack-classes/RESOURCE-EXHAUSTION-AND-AVAILABILITY.md` |
| Multi-tenant stores, caches/search, object links, analytics, export/backup, migration, deletion, retention, restore | `attack-classes/DATA-ISOLATION-AND-LIFECYCLE.md` |
| Native apps, deep links, webview bridges, exported components, privileged helpers, local daemons, XPC/Binder/D-Bus/Unix sockets | `attack-classes/DESKTOP-MOBILE-AND-LOCAL-IPC.md` |
| Ordinary web/service logic with no special domain | `attack-classes/ATTACK-CLASSES.md` (injection, access control, resource/file handling, plus the general classes) |

One block crossing several domains takes sections from each — an upload endpoint behind auth in an LLM pipeline gets the relevant AUTH, INPUT, and AI sections together.

## How to use it

- Audit agents have `read`, so both options work: paste the relevant sections into the block task text (preferred — bounded context), or point the agent at the absolute path and the sections to read.
- Every companion opens with a **Core discipline** block of "what is not a finding" rules for that domain. Include it. These suppress the classic domain false positives (prompt injection ≠ vulnerability, mutable dependency ≠ vulnerability, unreachable `eval` ≠ critical).
- The companions assume a hunter that returns structured findings. Ours return the finding contract — the knowledge maps cleanly: their "candidate/confirmed" language becomes our statuses, and their "needs validation when the decisive fact is outside source" rule is exactly our `uncertain` + `blocked_on`.

## What not to do

- Do not hand an agent a whole companion when one subsection applies — that is noise, not coverage.
- Do not skip the Core discipline block to save tokens; it is the cheapest false-positive filter in the system.
- Do not treat these as a checklist to diff against. A checklist deviation with no reachable boundary violation is anti-pattern #1.
