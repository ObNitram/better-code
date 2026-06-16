import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

interface ExplorerViewActionConfig {
  name?: unknown;
  description?: unknown;
  command?: unknown;
  cwd?: unknown;
  terminalName?: unknown;
  match?: unknown;
  useTerminal?: unknown;
}

interface FormatterConfig {
  language?: unknown;
  languages?: unknown;
  command?: unknown;
  cwd?: unknown;
  match?: unknown;
}

interface BackgroundTaskConfig {
  name?: unknown;
  command?: unknown;
  cwd?: unknown;
  outputChannel?: unknown;
  terminalName?: unknown;
  useTerminal?: unknown;
}

interface MatchableConfig {
  match?: string;
  matchRegex?: RegExp;
}

interface ExplorerViewAction {
  name: string;
  description: string;
  command: string;
  cwd?: string;
  terminalName?: string;
  match?: string;
  matchRegex?: RegExp;
  useTerminal: boolean;
}

interface Formatter extends MatchableConfig {
  languages: string[];
  command: string;
  cwd?: string;
}

interface BackgroundTask {
  name: string;
  command: string;
  cwd?: string;
  outputChannel: string;
  terminalName?: string;
  useTerminal: boolean;
}

type TemplateVariables = Record<string, string>;

interface CpuSnapshot {
  idle: number;
  total: number;
}

interface DiskUsage {
  used: number;
  total: number;
}

type StatusSegmentKey = 'cpu' | 'frequency' | 'memory' | 'disk';

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

async function setupExampleConfigs(_context: vscode.ExtensionContext): Promise<void> {
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

async function startBackgroundTasks(context: vscode.ExtensionContext): Promise<void> {
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
      startBackgroundTask(task, workspaceFolder, variables, output, context);
    }
  }
}

function startBackgroundTask(
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
    logBackgroundTaskEvent(output, 'ERROR', task, workspaceFolder, 'empty command');
    return;
  }

  if (task.useTerminal) {
    logBackgroundTaskEvent(output, 'START', task, workspaceFolder, `terminal command=${command}`);
    const terminal = vscode.window.createTerminal({
      name: task.terminalName ?? task.name ?? 'Background Task',
      cwd
    });

    terminal.show();
    terminal.sendText(command, true);
    logBackgroundTaskEvent(output, 'SUCCESS', task, workspaceFolder, 'sent to terminal');
    return;
  }

  logBackgroundTaskEvent(output, 'START', task, workspaceFolder, `command=${command}`);
  const child = spawn(command, {
    cwd,
    shell: true,
    windowsHide: true
  });

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
    logBackgroundTaskEvent(output, 'ERROR', task, workspaceFolder, error.message, startedAt);
  });

  child.on('close', (code, signal) => {
    if (code === 0) {
      logBackgroundTaskEvent(output, 'SUCCESS', task, workspaceFolder, 'completed', startedAt);
      return;
    }

    const status = signal ? `signal ${signal}` : `exit code ${code}`;
    const details = stderr.trim() ? `: ${stderr.trim()}` : '';
    logBackgroundTaskEvent(output, 'ERROR', task, workspaceFolder, `failed with ${status}${details}`, startedAt);
  });

  context.subscriptions.push({
    dispose: () => {
      if (!child.killed) {
        child.kill();
      }
    }
  });
}

async function runExplorerViewAction(
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
    logExplorerViewActionEvent(output, 'START', picked, workspaceFolder, targets, `terminal command=${command}`);
    const terminal = vscode.window.createTerminal({
      name: picked.terminalName ?? picked.name ?? 'Explorer View Action',
      cwd
    });

    terminal.show();
    terminal.sendText(command, true);
    logExplorerViewActionEvent(output, 'SUCCESS', picked, workspaceFolder, targets, 'sent to terminal');
    return;
  }

  const startedAt = Date.now();
  logExplorerViewActionEvent(output, 'START', picked, workspaceFolder, targets, `command=${command}`);
  try {
    await runLoggedExplorerViewActionCommand(command, cwd, output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logExplorerViewActionEvent(output, 'ERROR', picked, workspaceFolder, targets, message, startedAt);
    throw error;
  }

  logExplorerViewActionEvent(output, 'SUCCESS', picked, workspaceFolder, targets, 'completed', startedAt);
}

class ConfiguredFormattingProvider implements vscode.DocumentFormattingEditProvider {
  constructor(private readonly output: vscode.OutputChannel) { }

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.TextEdit[]> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return [];
    }

    const formatter = normalizeFormatters(
      vscode.workspace.getConfiguration('obnicode', workspaceFolder.uri).get('formatters')
    ).find((candidate) => appliesToDocument(candidate, workspaceFolder, document));

    if (!formatter) {
      return [];
    }

    const stats = await fs.promises.stat(document.uri.fsPath);
    const variables = buildVariables(document.uri, workspaceFolder, stats, [document.uri]);
    const command = interpolate(formatter.command, variables);
    const cwd = interpolate(formatter.cwd ?? '${rawWorkspaceFolder}', variables);
    const startedAt = Date.now();
    this.logFormatterEvent('START', document, workspaceFolder, `command=${command}`);

    if (!command.trim()) {
      const message = `Formatter for "${document.languageId}" has an empty command.`;
      this.logFormatterEvent('ERROR', document, workspaceFolder, message);
      return [];
    }

    const original = document.getText();
    let formatted: string;
    try {
      formatted = await runFormatterCommand(command, cwd, original, token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logFormatterEvent('ERROR', document, workspaceFolder, message, startedAt);
      return [];
    }

    if (token.isCancellationRequested || formatted === original) {
      this.logFormatterEvent('SUCCESS', document, workspaceFolder, 'no changes', startedAt);
      return [];
    }

    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(original.length)
    );

    this.logFormatterEvent('SUCCESS', document, workspaceFolder, 'document changed', startedAt);
    return [vscode.TextEdit.replace(fullRange, formatted)];
  }

  private logFormatterEvent(
    status: 'START' | 'SUCCESS' | 'ERROR',
    document: vscode.TextDocument,
    workspaceFolder: vscode.WorkspaceFolder,
    message: string,
    startedAt?: number
  ): void {
    const elapsed = startedAt === undefined ? '' : ` duration=${Date.now() - startedAt}ms`;
    const relativePath = getMatchPath(document.uri, workspaceFolder);
    this.output.appendLine(
      `[${new Date().toISOString()}] ${status} ${relativePath} language=${document.languageId}${elapsed} ${message}`
    );
  }
}

function getTargets(resourceUri?: vscode.Uri, selectedUris?: vscode.Uri[]): vscode.Uri[] {
  const candidates = Array.isArray(selectedUris) && selectedUris.length > 0
    ? selectedUris
    : resourceUri
      ? [resourceUri]
      : [];

  return candidates.filter((uri) => uri.scheme === 'file');
}

function normalizeExplorerViewActions(value: unknown): ExplorerViewAction[] {
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

function normalizeBackgroundTasks(value: unknown): BackgroundTask[] {
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

function normalizeFormatters(value: unknown): Formatter[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is FormatterConfig => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const languages = normalizeLanguages(item.language, item.languages);
      const command = stringValue(item.command || '');
      const match = item.match === undefined ? undefined : stringValue(item.match);

      return {
        languages,
        command,
        cwd: item.cwd === undefined ? undefined : stringValue(item.cwd),
        match,
        matchRegex: match ? compileMatchRegex(`formatter for ${languages.join(', ')}`, match) : undefined
      };
    })
    .filter((item) => item.languages.length > 0 && item.command.trim().length > 0);
}

function normalizeLanguages(language: unknown, languages: unknown): string[] {
  const values = [
    ...(typeof language === 'string' ? [language] : []),
    ...(Array.isArray(languages) ? languages.filter((item): item is string => typeof item === 'string') : [])
  ];

  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
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

function buildVariables(
  target: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder,
  stats: fs.Stats,
  allTargets: vscode.Uri[]
): TemplateVariables {
  const filePath = target.fsPath;
  const workspacePath = workspaceFolder.uri.fsPath;
  const relativePath = path.relative(workspacePath, filePath);
  const selectedPaths = allTargets.map((uri) => quoteShell(uri.fsPath)).join(' ');

  return {
    path: quoteShell(filePath),
    rawPath: filePath,
    relativePath: quoteShell(relativePath),
    rawRelativePath: relativePath,
    workspaceFolder: quoteShell(workspacePath),
    rawWorkspaceFolder: workspacePath,
    fileBasename: quoteShell(path.basename(filePath)),
    rawFileBasename: path.basename(filePath),
    fileDirname: quoteShell(path.dirname(filePath)),
    rawFileDirname: path.dirname(filePath),
    selectedPaths,
    selectedType: stats.isDirectory() ? 'folder' : 'file'
  };
}

function appliesToTargets(
  action: MatchableConfig,
  workspaceFolder: vscode.WorkspaceFolder,
  targets: vscode.Uri[]
): boolean {
  if (!action.matchRegex) {
    return true;
  }

  return targets.every((target) => action.matchRegex?.test(getMatchPath(target, workspaceFolder)));
}

function appliesToDocument(
  formatter: Formatter,
  workspaceFolder: vscode.WorkspaceFolder,
  document: vscode.TextDocument
): boolean {
  return formatter.languages.includes(document.languageId)
    && appliesToTargets(formatter, workspaceFolder, [document.uri]);
}

function getMatchPath(target: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): string {
  const relativePath = path.relative(workspaceFolder.uri.fsPath, target.fsPath);
  return normalizePathForMatch(relativePath || '.');
}

function normalizePathForMatch(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function compileMatchRegex(label: string, pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid match regex for "${label}": ${message}`);
  }
}

function logExplorerViewActionEvent(
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

function logBackgroundTaskEvent(
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

function runLoggedExplorerViewActionCommand(
  command: string,
  cwd: string,
  output: vscode.OutputChannel
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true
    });

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

function runFormatterCommand(
  command: string,
  cwd: string,
  input: string,
  token: vscode.CancellationToken
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error?: Error, output?: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      cancellation.dispose();

      if (error) {
        reject(error);
      } else {
        resolve(output ?? '');
      }
    };

    const cancellation = token.onCancellationRequested(() => {
      child.kill();
      finish(new Error('Formatting cancelled.'));
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      finish(error);
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(undefined, stdout);
        return;
      }

      const status = signal ? `signal ${signal}` : `exit code ${code}`;
      const details = stderr.trim() ? `: ${stderr.trim()}` : '';
      finish(new Error(`Formatter command failed with ${status}${details}`));
    });

    child.stdin.end(input, 'utf8');
  });
}

function startSystemStatusBar(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = 'System Status';

  let previousCpu = getCpuSnapshot();
  const segmentWidths = new Map<StatusSegmentKey, number>();
  let updating = false;

  const update = async (): Promise<void> => {
    if (updating) {
      return;
    }

    updating = true;
    try {
      const configuration = vscode.workspace.getConfiguration('obnicode.systemStatus');
      const enabled = configuration.get<boolean>('enabled', true);

      if (!enabled) {
        item.hide();
        return;
      }

      const cpu = getCpuUsage(previousCpu);
      previousCpu = cpu.snapshot;

      const memory = getMemoryUsage();
      const disk = await getDiskUsage(getConfiguredDiskPath());
      const frequency = getCpuFrequency();
      const segments = [
        getStableStatusSegment('cpu', `$(pulse) ${formatPercent(cpu.percent)}`, segmentWidths),
        getStableStatusSegment('frequency', `$(dashboard) ${frequency}`, segmentWidths),
        getStableStatusSegment(
          'memory',
          `$(ellipsis) ${formatBytes(memory.used)}/${formatBytes(memory.total)}`,
          segmentWidths
        ),
        getStableStatusSegment(
          'disk',
          `$(database) ${disk ? `${formatBytes(disk.used)}/${formatBytes(disk.total)} used` : '--'}`,
          segmentWidths
        )
      ];

      item.text = segments.join('    ');

      item.tooltip = [
        'ObniCode system status',
        `CPU usage: ${formatPercent(cpu.percent)}`,
        `CPU frequency: ${frequency}`,
        `RAM used: ${formatBytes(memory.used)} / ${formatBytes(memory.total)}`,
        disk
          ? `Storage used: ${formatBytes(disk.used)} / ${formatBytes(disk.total)}`
          : 'Storage used: unavailable'
      ].join('\n');

      item.show();
    } finally {
      updating = false;
    }
  };

  const intervalMs = Math.max(
    1000,
    vscode.workspace
      .getConfiguration('obnicode.systemStatus')
      .get<number>('updateIntervalMs', 3000)
  );
  const interval = setInterval(update, intervalMs);

  update();
  context.subscriptions.push(item, { dispose: () => clearInterval(interval) });
}

function getCpuSnapshot(): CpuSnapshot {
  return os.cpus().reduce(
    (snapshot, cpu) => {
      const times = cpu.times;
      const total = times.user + times.nice + times.sys + times.idle + times.irq;

      return {
        idle: snapshot.idle + times.idle,
        total: snapshot.total + total
      };
    },
    { idle: 0, total: 0 }
  );
}

function getCpuUsage(previous: CpuSnapshot): { percent: number; snapshot: CpuSnapshot } {
  const snapshot = getCpuSnapshot();
  const idleDelta = snapshot.idle - previous.idle;
  const totalDelta = snapshot.total - previous.total;
  const percent = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;

  return {
    percent: clamp(percent, 0, 100),
    snapshot
  };
}

function getCpuFrequency(): string {
  const cpus = os.cpus();
  if (cpus.length === 0) {
    return '--';
  }

  const averageMhz = cpus.reduce((sum, cpu) => sum + cpu.speed, 0) / cpus.length;
  if (!Number.isFinite(averageMhz) || averageMhz <= 0) {
    return '--';
  }

  return averageMhz >= 1000
    ? `${(averageMhz / 1000).toFixed(1)}GHz`
    : `${Math.round(averageMhz)}MHz`;
}

function getMemoryUsage(): { used: number; total: number } {
  const total = os.totalmem();
  return {
    used: total - os.freemem(),
    total
  };
}

function getConfiguredDiskPath(): string {
  const configured = vscode.workspace
    .getConfiguration('obnicode.systemStatus')
    .get<string>('diskPath', '');

  if (configured.trim()) {
    return configured;
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
}

function getDiskUsage(targetPath: string): Promise<DiskUsage | undefined> {
  return new Promise((resolve) => {
    execFile('df', ['-kP', targetPath], (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }

      const lines = stdout.trim().split(/\r?\n/);
      if (lines.length < 2) {
        resolve(undefined);
        return;
      }

      const columns = lines[1].trim().split(/\s+/);
      const totalBlocks = Number(columns[1]);
      const usedBlocks = Number(columns[2]);

      if (!Number.isFinite(totalBlocks) || !Number.isFinite(usedBlocks)) {
        resolve(undefined);
        return;
      }

      resolve({
        used: usedBlocks * 1024,
        total: totalBlocks * 1024
      });
    });
  });
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return `${gib.toFixed(1)} GB`;
}

function getStableStatusSegment(
  key: StatusSegmentKey,
  value: string,
  segmentWidths: Map<StatusSegmentKey, number>
): string {
  const width = Math.max(segmentWidths.get(key) ?? 0, value.length);
  segmentWidths.set(key, width);
  return value.padEnd(width, ' ');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function interpolate(template: string, variables: TemplateVariables): string {
  return String(template).replace(/\$\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
  });
}

export function quoteShell(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

export function deactivate(): void { }
