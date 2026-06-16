import { spawn } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { BackgroundTask, TemplateVariables } from './types';
import { buildVariables, interpolate, stringValue } from './utils';

interface BackgroundTaskConfig {
  name?: unknown;
  command?: unknown;
  cwd?: unknown;
  outputChannel?: unknown;
  terminalName?: unknown;
  useTerminal?: unknown;
}

export function normalizeBackgroundTasks(value: unknown): BackgroundTask[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is BackgroundTaskConfig => Boolean(item) && typeof item === 'object')
    .map((item, index) => ({
      name: stringValue(item.name || `Background task ${index + 1}`),
      command: stringValue(item.command || ''),
      cwd: item.cwd === undefined ? undefined : stringValue(item.cwd),
      outputChannel: stringValue(item.outputChannel || ''),
      terminalName: item.terminalName === undefined ? undefined : stringValue(item.terminalName),
      useTerminal: item.useTerminal === true
    }))
    .filter((item) => item.command.trim().length > 0 && (item.useTerminal || item.outputChannel.trim().length > 0));
}

export async function startBackgroundTasks(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (workspaceFolders.length === 0) {
    return;
  }

  const outputChannels = new Map<string, vscode.OutputChannel>();
  const getOutputChannel = (name: string): vscode.OutputChannel => {
    const existing = outputChannels.get(name);
    if (existing) {
      return existing;
    }

    const output = vscode.window.createOutputChannel(name);
    outputChannels.set(name, output);
    context.subscriptions.push(output);
    return output;
  };

  const startupOutput = getOutputChannel('obnicode.backgroundTasks');

  for (const workspaceFolder of workspaceFolders) {
    const tasks = normalizeBackgroundTasks(
      vscode.workspace.getConfiguration('obnicode', workspaceFolder.uri).get('backgroundTasks')
    );
    if (tasks.length === 0) {
      continue;
    }

    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(workspaceFolder.uri.fsPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      startupOutput.appendLine(
        `[${new Date().toISOString()}] ERROR ${workspaceFolder.name} failed to stat workspace folder: ${message}`
      );
      continue;
    }

    const variables = buildVariables(workspaceFolder.uri, workspaceFolder, stats, [workspaceFolder.uri]);
    for (const task of tasks) {
      const output = getOutputChannel(task.useTerminal ? 'obnicode.backgroundTasks' : task.outputChannel);
      startTask(task, workspaceFolder, variables, output, context);
    }
  }
}

function startTask(
  task: BackgroundTask,
  workspaceFolder: vscode.WorkspaceFolder,
  variables: TemplateVariables,
  output: vscode.OutputChannel,
  context: vscode.ExtensionContext
): void {
  const command = interpolate(task.command, variables);
  const cwd = interpolate(task.cwd ?? '${rawWorkspaceFolder}', variables);
  const startedAt = Date.now();

  if (!command.trim()) {
    logEvent(output, 'ERROR', task, workspaceFolder, 'empty command');
    return;
  }

  if (task.useTerminal) {
    logEvent(output, 'START', task, workspaceFolder, `terminal command=${command}`);
    const terminal = vscode.window.createTerminal({
      name: task.terminalName ?? task.name ?? 'Background Task',
      cwd
    });

    terminal.show();
    terminal.sendText(command, true);
    logEvent(output, 'SUCCESS', task, workspaceFolder, 'sent to terminal');
    return;
  }

  logEvent(output, 'START', task, workspaceFolder, `command=${command}`);
  const child = spawn(command, { cwd, shell: true, windowsHide: true });

  let stderr = '';

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
    logEvent(output, 'ERROR', task, workspaceFolder, error.message, startedAt);
  });

  child.on('close', (code, signal) => {
    if (code === 0) {
      logEvent(output, 'SUCCESS', task, workspaceFolder, 'completed', startedAt);
      return;
    }

    const status = signal ? `signal ${signal}` : `exit code ${code}`;
    const details = stderr.trim() ? `: ${stderr.trim()}` : '';
    logEvent(output, 'ERROR', task, workspaceFolder, `failed with ${status}${details}`, startedAt);
  });

  context.subscriptions.push({
    dispose: () => {
      if (!child.killed) {
        child.kill();
      }
    }
  });
}

function logEvent(
  output: vscode.OutputChannel,
  status: 'START' | 'SUCCESS' | 'ERROR',
  task: BackgroundTask,
  workspaceFolder: vscode.WorkspaceFolder,
  message: string,
  startedAt?: number
): void {
  const elapsed = startedAt === undefined ? '' : ` duration=${Date.now() - startedAt}ms`;
  output.appendLine(
    `[${new Date().toISOString()}] ${status} ${task.name} workspace=${workspaceFolder.name}${elapsed} ${message}`
  );
}
