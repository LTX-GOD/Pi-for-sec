## Python & Environment Management

- Package Manager: Use `uv` for all Python-related tasks.
- Execution: When running any local Python script, ALWAYS use the command format: `uv run <script_name>.py`.
- Dependencies:
  - If a script needs a new library, use `uv add <package>`
  - Or run it via `uv run --with <package> <script>.py`.
- Environment: Do not use `pip` or `venv` directly; trust `pyproject.toml` or `uv`'s inline dependency management.
- Script Location: All scripts must be created in the **current working directory (`./`)**. Do not place scripts in subdirectories unless explicitly requested.

## Node.js & bun & Frontend Management

- **Runtime Manager**: Use `fnm` for Node.js version management. 
- **Package Manager**: ALWAYS use `pnpm` for all Node.js related tasks. DO NOT use `npm` or `yarn` unless explicitly requested.
- **Global Packages**: When installing global CLI tools, use `pnpm add -g <package>`.
- **Execution**: 
  - Use `pnpm exec <command>` or `pnpx <command>` to run local binaries.
  - To run a script defined in `package.json`, use `pnpm <script_name>`.
- **Dependency Management**:
  - Add dependencies: `pnpm add <package>`
  - Add dev-dependencies: `pnpm add -D <package>`
- **Environment Consistency**: 
  - If a `.node-version` or `.nvmrc` file exists, respect the version specified.
  - Trust `pnpm-lock.yaml` as the single source of truth for dependencies.
- **Neovim Integration**: When suggesting LSP or Linter installations, prioritize using `Mason` within Neovim, or `pnpm add -g` for global language servers.
- if have `bunfig.toml`,first use `bun`

## AboutSecurity MCP Usage

- The local MCP server `aboutsecurity` is the primary security/CTF knowledge base and skill router.
- For any CTF, Web security, reverse engineering, pwn, crypto, forensics, malware, OSINT, fuzzing, payload research, vulnerability verification, pentest, intranet, AD, Redis, JWT/OAuth, SSRF, Nuclei, ffuf, or exploit-development task, proactively consult `aboutsecurity` before choosing a detailed attack path.
- Prefer this MCP lookup sequence:
  1. `mcp({ server: "aboutsecurity" })` only when tool availability is uncertain.
  2. `mcp({ tool: "aboutsecurity_search_security", args: "{\"query\":\"<task keywords>\"}" })` to find the relevant skill/knowledge entry.
  3. `mcp({ tool: "aboutsecurity_get_security_detail", args: "{\"id\":\"<result id>\"}" })` when a search result looks relevant.
  4. `mcp({ tool: "aboutsecurity_read_security_file", args: "{...}" })` when the result points to a dictionary, payload list, or reference file.
- Do not wait for the user to explicitly say "use aboutsecurity" during CTF work. Use it as the first-pass context source when the problem category is security-related.
- If aboutsecurity is unavailable, continue with local skills/files, but mention the MCP failure briefly.

## The last

speek Chinese with me
