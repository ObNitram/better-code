import * as vscode from 'vscode';
import { startBackgroundTasks } from './backgroundTasks';
import { runExplorerViewAction } from './explorerViewActions';
import { ConfiguredFormattingProvider, normalizeFormatters } from './formatters';
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

  startFormattingProviders(context, formatterOutput);

  context.subscriptions.push(
    runExplorerViewActionCommand,
    setupExampleCommand,
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

function startFormattingProviders(context: vscode.ExtensionContext, formatterOutput: vscode.OutputChannel): void {
  let registrations: vscode.Disposable[] = [];

  const refresh = (): void => {
    for (const registration of registrations) {
      registration.dispose();
    }

    registrations = getConfiguredFormatterLanguages().map((language) =>
      vscode.languages.registerDocumentFormattingEditProvider(
        { scheme: 'file', language },
        new ConfiguredFormattingProvider(formatterOutput)
      )
    );
  };

  refresh();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('obnicode.formatters')) {
        refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    {
      dispose: () => {
        for (const registration of registrations) {
          registration.dispose();
        }
      }
    }
  );
}

function getConfiguredFormatterLanguages(): string[] {
  const languages = new Set<string>();
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (!workspaceFolders || workspaceFolders.length === 0) {
    addConfiguredFormatterLanguages(languages, vscode.workspace.getConfiguration('obnicode').get('formatters'));
  } else {
    for (const folder of workspaceFolders) {
      addConfiguredFormatterLanguages(
        languages,
        vscode.workspace.getConfiguration('obnicode', folder.uri).get('formatters')
      );
    }
  }

  return [...languages].sort();
}

function addConfiguredFormatterLanguages(languages: Set<string>, value: unknown): void {
  for (const formatter of normalizeFormatters(value)) {
    for (const language of formatter.languages) {
      languages.add(language);
    }
  }
}
