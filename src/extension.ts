import * as vscode from 'vscode';
import { startBackgroundTasks } from './backgroundTasks';
import { runExplorerViewAction } from './explorerViewActions';
import { ConfiguredFormattingProvider } from './formatters';
import { setupExampleConfigs } from './setup';
import { startSystemStatusBar } from './systemStatus';

export function activate(context: vscode.ExtensionContext): void {
  const formatterOutput = vscode.window.createOutputChannel('obnicode.formatters');
  const explorerViewActionOutput = vscode.window.createOutputChannel('obnicode.explorerViewActions');

  const runExplorerViewActionCommand = vscode.commands.registerCommand(
    'obnicode.run',
    async (resourceUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
      try {
        await runExplorerViewAction(explorerViewActionOutput, resourceUri, selectedUris);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Explorer view action failed: ${message}`);
      }
    }
  );

  const setupExampleCommand = vscode.commands.registerCommand(
    'obnicode.setupExample',
    async () => {
      try {
        await setupExampleConfigs(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Setup failed: ${message}`);
      }
    }
  );

  const formattingProvider = vscode.languages.registerDocumentFormattingEditProvider(
    { scheme: 'file' },
    new ConfiguredFormattingProvider(formatterOutput)
  );

  context.subscriptions.push(
    runExplorerViewActionCommand,
    setupExampleCommand,
    formattingProvider,
    formatterOutput,
    explorerViewActionOutput
  );

  startSystemStatusBar(context);

  void startBackgroundTasks(context).catch((error) => {
    const output = vscode.window.createOutputChannel('obnicode.backgroundTasks');
    context.subscriptions.push(output);
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[${new Date().toISOString()}] ERROR failed to start background tasks: ${message}`);
  });
}

export function deactivate(): void {}
