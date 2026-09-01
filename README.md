# ObniCode

VS Code extension for configuring custom Explorer actions, document formatters, and a system-status indicator.

Configuration is managed through VS Code settings, at either workspace or workspace-folder level.

## Explorer Actions

Configured actions appear in the context menu for files and folders. The **Run Explorer View Action** command opens the list of actions that apply to the current selection.

Available options:

- `name` and `command` are required.
- `description` adds a description to the action picker.
- `cwd` defines the command working directory.
- `match` filters an action with a regular expression applied to the workspace-relative path.
- `useTerminal` runs the command in an integrated terminal.
- `terminalName` customizes the terminal name.

Commands run in the background write their output to the `obnicode.explorerViewActions` output channel. Start, success, and error events are logged.

## Formatters

Formatters use a shell command that receives the document content through `stdin` and returns formatted content through `stdout`.

A formatter can target one language with `language`, or several with `languages`. The first formatter matching both the language and path is used. Runs are logged to `obnicode.formatters`.

## Variables

Shell-escaped variables:

- `${path}`
- `${relativePath}`
- `${workspaceFolder}`
- `${fileBasename}`
- `${fileDirname}`
- `${selectedPaths}`

Raw variables, useful in particular for `cwd`:

- `${rawPath}`
- `${rawRelativePath}`
- `${rawWorkspaceFolder}`
- `${rawFileBasename}`
- `${rawFileDirname}`

`${selectedType}` is either `file` or `folder`.

## System Status Bar

The extension displays CPU usage, CPU frequency, used and total RAM, and used and total storage in the status bar.

Available settings:

- `obnicode.systemStatus.enabled`
- `obnicode.systemStatus.showCpu`
- `obnicode.systemStatus.showFrequency`
- `obnicode.systemStatus.showMemory`
- `obnicode.systemStatus.showDisk`
- `obnicode.systemStatus.updateIntervalMs`
- `obnicode.systemStatus.diskPath`

## Example Configuration

The **ObniCode: Setup ObniCode Example** command adds example Explorer actions and a formatter to workspace-folder settings. It asks for confirmation when actions already exist.

## Development

1. Open this project in VS Code.
2. Run `npm install`.
3. Run `npm run setup:hooks`.
4. Run `npm run compile`.
5. Press `F5` to start the Extension Development Host.
6. Run **ObniCode: Setup ObniCode Example** or configure the `obnicode.*` settings.

## Build VSIX

```text
npm run build:vsix
```

The command checks the project, compiles it, then generates the VSIX file.
