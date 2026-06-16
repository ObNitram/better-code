import * as vscode from 'vscode';

export async function setupExampleConfigs(_context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error('Open a workspace folder before setting up ObniCode examples.');
  }

  const config = vscode.workspace.getConfiguration('obnicode', workspaceFolder.uri);
  const existingActions = config.get<unknown[]>('explorerViewActions', []);

  if (existingActions.length > 0) {
    const overwrite = await vscode.window.showWarningMessage(
      'ObniCode settings already exist. Overwrite them?',
      { modal: true },
      'Overwrite'
    );

    if (overwrite !== 'Overwrite') {
      vscode.window.showInformationMessage('ObniCode example configuration already exists.');
      return;
    }
  }

  await config.update('explorerViewActions', [
    {
      name: 'Print selected path',
      description: 'Echo the selected file or folder path',
      command: 'echo ${path}',
      useTerminal: false
    },
    {
      name: 'List files',
      description: 'List files in the selected folder',
      command: 'ls -la ${rawPath}',
      useTerminal: true,
      match: '.*'
    }
  ], vscode.ConfigurationTarget.WorkspaceFolder);

  await config.update('backgroundTasks', [
    {
      name: 'Print workspace at startup',
      command: 'echo ${rawWorkspaceFolder}',
      outputChannel: 'obnicode.backgroundTasks',
      useTerminal: false
    }
  ], vscode.ConfigurationTarget.WorkspaceFolder);

  await config.update('formatters', [
    {
      language: 'json',
      command: 'jq .',
      match: '\\.json$'
    }
  ], vscode.ConfigurationTarget.WorkspaceFolder);

  vscode.window.showInformationMessage('ObniCode example settings added to workspace settings.');
}
