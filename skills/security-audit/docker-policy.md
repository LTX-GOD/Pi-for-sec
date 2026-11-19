# Docker policy for audit environments

Only `audit-environment` creates or changes environments. Only `audit-runtime` uses them. Everyone else is read-only against source.

## Non-negotiable rules

Forbidden without explicit, per-run human approval:

- `--privileged`, `--cap-add`, `--security-opt` relaxations
- mounting `/var/run/docker.sock` into any container
- `network_mode: host`, `pid: host`, `ipc: host`
- bind mounts outside the repository and the run workspace
- publishing ports on `0.0.0.0` or any non-loopback interface
- reusing an existing project's containers, volumes or database
- any connection to a host that is not part of the audit environment

An agent that needs one of these must stop and ask through `contact_supervisor`. The supervisor answers explicitly. Silence is denial.

## Isolation per run

Every audit run gets its own namespace:

```bash
COMPOSE_PROJECT_NAME=audit_<runId>
```

- dedicated network, volumes and containers derived from that project name
- host ports bound to `127.0.0.1` only, chosen from a free high range
- a per-run port offset so two audits can run side by side
- all generated files under `./tmp/security-audit/<runId>/env/`

Never edit the repository's committed compose or env files in place. Layer an override instead:

```bash
docker compose \
  -p "audit_<runId>" \
  -f docker-compose.yml \
  -f ./tmp/security-audit/<runId>/env/compose.override.yml \
  up -d --build
```

## Health gate

The environment is `ready` only when every required service passes an application-level check, not just "container is up":

- container state is `running` and not restart-looping
- the port answers on `127.0.0.1`
- a health or root endpoint returns an expected status
- migrations/seeds the app needs have actually applied

Anything else is `partial` or `failed`, with the log tail captured to `env/logs/`.

## Test identities

Runtime verification of access control needs at least two identities in two tenants, plus one elevated role when the app has roles.

- create them through the application's own API or documented seed path
- record how they were created in the manifest
- store secrets in `env/credentials.json` inside the run workspace, never in returned JSON, prose, or the report
- never reuse real user data or production-shaped credentials

## Data safety

- Start from empty or fixture data. Never point the environment at a real database.
- Runtime probes use inert markers, not destructive payloads.
- Anything a runtime agent creates must be identifiable (`audit-<runId>-` prefix) and removable.
- Destructive tests require explicit approval and a disposable environment.

## Concurrency

- One `audit-environment` run at a time per project name.
- Multiple `audit-runtime` agents may share a ready environment **only** when their tests do not mutate shared state; otherwise serialize them.
- Parallel audits of different repos must use different project names and port ranges.

## Teardown

Always recorded, always scoped to the run's own project name:

```bash
docker compose -p "audit_<runId>" -f <files> down -v
```

Tear down when the runtime questions are answered, when the run ends, and when a build fails past the retry limit. Report anything left behind (dangling volumes, images, networks) instead of force-pruning the host.

## When Docker is unavailable

Do not attempt to install it. Report it, mark every `needs_runtime` finding as `uncertain` with its `runtime_question` intact, and finish the static audit. A partially verified audit with honest coverage beats a blocked one.
