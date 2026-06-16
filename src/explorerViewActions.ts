import { spawn } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { ExplorerViewAction } from './types';
import { appliesToTargets, buildVariables, compileMatchRegex, getMatchPath, interpolate, stringValue } from './utils';

interface ExplorerViewActionConfig {
  name?: unknown;
  description?: unknown;
  command?: unknown;
  cwd?: unknown;
  terminalName?: unknown;
  match?: unknown;
  useTerminal?: unknown;
}

export function normalizeExplorerViewActions(value: unknown): ExplorerViewAction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is ExplorerViewActionConfig => Boolean(item) && typeof item === 'object')
    .map((item, index) => ({
      name: stringValue(item.name || `Explorer view action ${index + 1}`),
      description: stringValue(item.description || ''),
      command: stringValue(item.command || ''),
      cwd: item.cwd === undefined ? undefined : stringValue(item.cwd),
      terminalName: item.terminalName === undefined ? undefined : stringValue(item.terminalName),
      match: item.match === undefined ? undefined : stringValue(item.match),
      useTerminal: item.useTerminal === true
    }))
    .map((item) => ({
      ...item,
      matchRegex: item.match ? compileMatchRegex(item.name, item.match) : undefined
    }))
    .filter((item) => item.command.trim().length > 0);
}

export async function runExplorerViewAction(
  output: vscode.OutputChannel,
  resourceUri?: vscode.Uri,
  selectedUris?: vscode.Uri[]
): Promise<void> {
  const targets = getTargets(resourceUri, selectedUris);
  if (targets.length === 0) {
    throw new Error('Right-click a file or folder in the Explorer.');
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(targets[0]);
  if (!workspaceFolder) {
    throw new Error('The selected item is not inside an open workspace.');
  }

  const allActions = normalizeExplorerViewActions(
    vscode.workspace.getConfiguration('obnicode', workspaceFolder.uri).get('explorerViewActions')
  );

  if (allActions.length === 0) {
    return;
  }

  const actions = allActions.filter((action) => appliesToTargets(action, workspaceFolder, targets));
  if (actions.length === 0) {
    return;
  }

  const picked = await pickExplorerViewAction(actions);
  if (!picked) {
    return;
  }

  const target = targets[0];
  const stats = await fs.promises.stat(target.fsPath);
  const variables = buildVariables(target, workspaceFolder, stats, targets);
  const command = interpolate(picked.command, variables);
  const cwd = interpolate(picked.cwd ?? '${rawWorkspaceFolder}', variables);

  if (!command.trim()) {
    throw new Error(`Explorer view action "${picked.name}" has an empty command.`);
  }

  if (picked.useTerminal) {
    logEvent(output, 'START', picked, workspaceFolder, targets, `terminal command=${command}`);
    const terminal = vscode.window.createTerminal({
      name: picked.terminalName ?? picked.name ?? 'Explorer View Action',
      cwd
    });

    terminal.show();
    terminal.sendText(command, true);
    logEvent(output, 'SUCCESS', picked, workspaceFolder, targets, 'sent to terminal');
    return;
  }

  const startedAt = Date.now();
  logEvent(output, 'START', picked, workspaceFolder, targets, `command=${command}`);
  try {
    await runCommand(command, cwd, output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent(output, 'ERROR', picked, workspaceFolder, targets, message, startedAt);
    throw error;
  }

  logEvent(output, 'SUCCESS', picked, workspaceFolder, targets, 'completed', startedAt);
}

function getTargets(resourceUri?: vscode.Uri, selectedUris?: vscode.Uri[]): vscode.Uri[] {
  const candidates = Array.isArray(selectedUris) && selectedUris.length > 0
    ? selectedUris
    : resourceUri
      ? [resourceUri]
      : [];

  return candidates.filter((uri) => uri.scheme === 'file');
}

async function pickExplorerViewAction(actions: ExplorerViewAction[]): Promise<ExplorerViewAction | undefined> {
  if (actions.length === 1) {
    return actions[0];
  }

  const picked = await vscode.window.showQuickPick(
    actions.map((action) => ({
      label: action.name,
      description: action.description,
      detail: action.command,
      action
    })),
    {
      title: 'Run Explorer View Action',
      placeHolder: 'Choose an explorer view action to run'
    }
  );

  return picked?.action;
}

function logEvent(
  output: vscode.OutputChannel,
  status: 'START' | 'SUCCESS' | 'ERROR',
  action: ExplorerViewAction,
  workspaceFolder: vscode.WorkspaceFolder,
  targets: vscode.Uri[],
  message: string,
  startedAt?: number
): void {
  const elapsed = startedAt === undefined ? '' : ` duration=${Date.now() - startedAt}ms`;
  const targetPaths = targets.map((target) => getMatchPath(target, workspaceFolder)).join(', ');
  output.appendLine(
    `[${new Date().toISOString()}] ${status} ${action.name} targets=${targetPaths}${elapsed} ${message}`
  );
}

function runCommand(command: string, cwd: string, output: vscode.OutputChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });

    let stderr = '';
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }

      settled = true;

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      output.append(chunk);
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      output.append(chunk);
    });

    child.on('error', (error) => {
      finish(error);
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }

      const status = signal ? `signal ${signal}` : `exit code ${code}`;
      const details = stderr.trim() ? `: ${stderr.trim()}` : '';
      finish(new Error(`Explorer view action command failed with ${status}${details}`));
    });

    child.stdin.end();
  });
}
