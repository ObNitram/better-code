# ObniCode

VS Code extension that adds a **Run Explorer View Action** entry to the Explorer right-click menu for files and folders.

Explorer view actions, startup background tasks, and formatters are read from a workspace YAML file:

```text
.vscode/obnicode.yaml
```

The extension contributes a YAML schema for this file, so editors with YAML schema support can show completion, inline documentation, and validation errors.

The configuration file is optional. If `.vscode/obnicode.yaml` is missing, no Explorer view actions, background tasks, or document formatters are added.

The native VS Code menu API does not allow runtime-generated menu entries with labels loaded from workspace YAML. The **Run Explorer View Action** command opens the filtered list of matching actions.

Run **ObniCode: Setup ObniCode Example** from the command palette to create an example `.vscode/obnicode.yaml` file in the current workspace. The source template lives in `examples/`.

## Explorer view actions configuration

```yaml
# .vscode/obnicode.yaml
# yaml-language-server: $schema=../schemas/obnicode.schema.json
explorerViewActions:
  - name: Print selected path
    description: Echo the selected file or folder path
    command: echo ${path}

  - name: List selected folder
    description: Run ls in the selected folder in a terminal
    match: ^src($|/)
    cwd: ${rawPath}
    useTerminal: true
    command: ls -la

  - name: Multi-line command
    match: ^(src|schemas)(/|$)
    command: |
      echo "Workspace: ${rawWorkspaceFolder}"
      echo "Selected: ${rawPath}"
```

Explorer view actions run in the background by default. Their start, success, errors, stdout, and stderr are written to the **obnicode.explorerViewActions** output channel.

Set `useTerminal: true` when an action needs an interactive shell or when you want the result displayed in a VS Code integrated terminal:

```yaml
explorerViewActions:
  - name: Interactive shell command
    command: npm run dev
    useTerminal: true
    terminalName: ObniCode dev server
```

## Formatters configuration

```yaml
formatters:
  - language: typescript
    match: ^src/.*\.ts$
    command: npx prettier --stdin-filepath ${path}

  - languages:
      - javascript
      - typescript
    command: npx prettier --stdin-filepath ${path}
```

## Background tasks

Add `backgroundTasks` to launch commands when the extension activates. Each task writes stdout, stderr, and lifecycle logs to the configured VS Code output channel:

```yaml
backgroundTasks:
  - name: Watch TypeScript
    command: npm run watch
    cwd: ${rawWorkspaceFolder}
    outputChannel: obnicode.watch
```

Background tasks are started once per workspace folder at extension activation. They are stopped when the extension is deactivated.

Set `useTerminal: true` when a background task needs an interactive shell or should stay visible in a terminal:

```yaml
backgroundTasks:
  - name: Dev server
    command: npm run dev
    cwd: ${rawWorkspaceFolder}
    useTerminal: true
    terminalName: ObniCode dev server
```

Options:

- `name`: required. Name used in output logs.
- `command`: required. Shell command launched at startup.
- `outputChannel`: required unless `useTerminal: true`. VS Code output channel receiving stdout, stderr, `START`, `SUCCESS`, and `ERROR` logs.
- `cwd`: optional. Working directory. Defaults to `${rawWorkspaceFolder}`.
- `useTerminal`: optional, default `false`. Runs the command in a VS Code integrated terminal.
- `terminalName`: optional. Terminal name when `useTerminal: true`.

## Supported variables

Shell-quoted variables:

- `${path}`
- `${relativePath}`
- `${workspaceFolder}`
- `${fileBasename}`
- `${fileDirname}`
- `${selectedPaths}`

Raw variables:

- `${rawPath}`
- `${rawRelativePath}`
- `${rawWorkspaceFolder}`
- `${rawFileBasename}`
- `${rawFileDirname}`

Other variables:

- `${selectedType}`: `file` or `folder`

Use shell-quoted variables by default. Raw variables are useful inside already-quoted strings.

Use raw variables for `cwd`, for example `${rawWorkspaceFolder}`, `${rawPath}`, or `${rawFileDirname}`.

## Match filters

Add `match` to restrict where an Explorer view action is available:

```yaml
explorerViewActions:
  - name: Compile TypeScript file
    match: ^src/.*\.ts$
    command: npm run compile
```

`match` is a JavaScript regular expression tested against the workspace-relative path, normalized with `/` separators. For example:

- `src/extension.ts` for a file
- `schemas/obnicode.schema.json` for a file
- `src` for a folder
- `.` for the workspace root

When multiple files or folders are selected, all selected paths must match the regex.

The same `match` property is available for formatters.

## Formatters

Add `formatters` to define document formatters by VS Code language id:

```yaml
formatters:
  - language: typescript
    match: ^src/.*\.ts$
    command: npx prettier --stdin-filepath ${path}
```

The formatter command receives the full document content on standard input and must write the formatted content to standard output. The extension replaces the whole document with stdout when the command exits with code `0`.

You can target one language with `language` or several with `languages`:

```yaml
formatters:
  - languages:
      - javascript
      - typescript
    command: npx prettier --stdin-filepath ${path}
```

The first formatter matching the document language and optional `match` regex is used.

Formatter runs are logged to the **obnicode.formatters** output channel with the file path, language id, status, duration, and error message when a formatter fails.

## System status bar

The extension also shows a status bar item with:

- `$(pulse)` CPU usage percentage
- `$(dashboard)` CPU frequency
- `$(ellipsis)` RAM used / RAM total
- `$(database)` storage used / storage total

Example:

```text
$(pulse) 12%    $(dashboard) 3.2 GHz    $(ellipsis) 9.5 GB/32.0 GB    $(database) 137.6 GB/239.4 GB used
```

Settings:

- `obnicode.configFile`: workspace-relative path to the ObniCode YAML file, default `.vscode/obnicode.yaml`
- `obnicode.systemStatus.enabled`: show or hide the item
- `obnicode.systemStatus.updateIntervalMs`: refresh interval, default `3000`
- `obnicode.systemStatus.diskPath`: path used to measure storage, default first workspace folder

## Schema

The schema is associated through the `yamlValidation` contribution in `package.json`:

- `schemas/obnicode.schema.json` for `.vscode/obnicode.yaml`

Validated shape:

- top-level `explorerViewActions`, `backgroundTasks`, and `formatters` arrays are all optional
- each Explorer view action requires `name` and `command`
- optional properties are `description`, `cwd`, `match`, `terminalName`, and `useTerminal`
- each background task requires `name` and `command`
- background task `outputChannel` is required unless `useTerminal: true`
- background task optional properties are `cwd`, `outputChannel`, `useTerminal`, and `terminalName`
- each formatter requires `command` and either `language` or `languages`
- unknown properties are rejected

## Development

1. Open this folder in VS Code.
2. Run `npm install`.
3. Run `npm run compile`.
4. Press `F5` to start an Extension Development Host.
5. In the test workspace, run **ObniCode: Setup ObniCode Example** or create `.vscode/obnicode.yaml`.
6. Right-click a file or folder in the Explorer and choose **Run Explorer View Action**.

## Build VSIX

Run:

```bash
npm run build:vsix
```

The script runs `npm run check`, then `npm run compile`, then `vsce package`.
