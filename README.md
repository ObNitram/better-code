# ObniCode

VS Code extension that adds a **Run Custom Actions** entry to the Explorer right-click menu for files and folders.

Functions and formatters are read from separate workspace YAML files:

```text
.vscode/functions.yaml
.vscode/formatters.yaml
```

The extension contributes YAML schemas for both files, so editors with YAML schema support can show completion, inline documentation, and validation errors.

Both configuration files are optional. If `.vscode/functions.yaml` is missing, no context actions are added. If `.vscode/formatters.yaml` is missing, no document formatters are added.

The native VS Code menu API does not allow runtime-generated menu entries with labels loaded from workspace YAML. The **Run Custom Actions** command opens the filtered list of matching functions.

Run **ObniCode: Setup ObniCode Example** from the command palette to create example `.vscode/functions.yaml` and `.vscode/formatters.yaml` files in the current workspace. The source templates live in `examples/`.

## Functions configuration

```yaml
# .vscode/functions.yaml
# yaml-language-server: $schema=../schemas/functions.schema.json
functions:
  - name: Print selected path
    description: Echo the selected file or folder path
    command: echo ${path}

  - name: List selected folder
    description: Run ls in the selected folder
    match: ^src($|/)
    cwd: ${rawPath}
    command: ls -la

  - name: Multi-line command
    match: ^(src|schemas)(/|$)
    command: |
      echo "Workspace: ${rawWorkspaceFolder}"
      echo "Selected: ${rawPath}"
```

## Formatters configuration

```yaml
# .vscode/formatters.yaml
# yaml-language-server: $schema=../schemas/formatters.schema.json
formatters:
  - language: typescript
    match: ^src/.*\.ts$
    command: npx prettier --stdin-filepath ${path}

  - languages:
      - javascript
      - typescript
    command: npx prettier --stdin-filepath ${path}
```

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

Add `match` to restrict where a function is available:

```yaml
functions:
  - name: Compile TypeScript file
    match: ^src/.*\.ts$
    command: npm run compile
```

`match` is a JavaScript regular expression tested against the workspace-relative path, normalized with `/` separators. For example:

- `src/extension.ts` for a file
- `schemas/functions.schema.json` for a file
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

- `obnicode.functionsConfigFile`: workspace-relative path to the functions YAML file, default `.vscode/functions.yaml`
- `obnicode.formattersConfigFile`: workspace-relative path to the formatters YAML file, default `.vscode/formatters.yaml`
- `obnicode.systemStatus.enabled`: show or hide the item
- `obnicode.systemStatus.updateIntervalMs`: refresh interval, default `3000`
- `obnicode.systemStatus.diskPath`: path used to measure storage, default first workspace folder

## Schema

The schemas are associated through the `yamlValidation` contribution in `package.json`:

- `schemas/functions.schema.json` for `.vscode/functions.yaml`
- `schemas/formatters.schema.json` for `.vscode/formatters.yaml`

Validated shape:

- top-level `functions` array is required in the functions config file
- top-level `formatters` array is required in the formatters config file
- each function requires `name` and `command`
- optional properties are `description`, `cwd`, `match`, and `terminalName`
- each formatter requires `command` and either `language` or `languages`
- unknown properties are rejected

## Development

1. Open this folder in VS Code.
2. Run `npm install`.
3. Run `npm run compile`.
4. Press `F5` to start an Extension Development Host.
5. In the test workspace, run **ObniCode: Setup ObniCode Example** or create `.vscode/functions.yaml` and/or `.vscode/formatters.yaml`.
6. Right-click a file or folder in the Explorer and choose **Run Custom Actions**.

## Build VSIX

Run:

```bash
npm run build:vsix
```

The script runs `npm run check`, then `npm run compile`, then `vsce package`.
