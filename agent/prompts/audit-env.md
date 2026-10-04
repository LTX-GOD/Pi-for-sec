---
description: Bring up or tear down the isolated Docker audit environment
argument-hint: "<runId> [up|down]"
---
Load the `security-audit` skill and follow `docker-policy.md` strictly.

Run `${2:-up}` for audit run `$1`.

For `up`:
1. Launch `audit-environment`. It must discover the project's own Docker setup before running anything.
2. Require isolation: `COMPOSE_PROJECT_NAME=audit_$1`, ports bound to `127.0.0.1`, overrides written under `./tmp/security-audit/$1/env/`, no edits to committed compose or env files.
3. Refuse privileged containers, Docker socket mounts, host networking and broad host bind mounts. If the agent asks for any of them, bring the request to me with the exact reason. Do not approve it yourself.
4. Require application-level health checks, not just container state.
5. Require at least two test identities in different tenants when access control is being audited.
6. Report the environment manifest. Credentials stay in the run workspace, never in chat.

For `down`:
1. Tear down only `audit_$1` with its recorded compose files and `-v`.
2. Confirm containers, network and volumes for that project are gone.
3. Report anything left behind. Do not prune the host.
