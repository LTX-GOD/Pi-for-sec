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

## TOOLS

- If you encounter an APK, use droidasc. You can use droidasc -h to view the commands.
- If you encounter a binary file, use idalib-mcp.
- If you encounter questions about methodology or vulnerability databases, use aboutsecurity.
- first use ffgrep/fffind and use recall to look history.

## 中间产物目录约定（全局硬性）

- 所有探测脚本、有用的信息等**中间产物一律写当前项目目录的 `./tmp/`**（不存在则创建），**严禁写 `/tmp/` 或系统临时目录**，便于统一清理与归档。
- 任务结束不主动删除中间产物（留证据），由用户统一清理。
