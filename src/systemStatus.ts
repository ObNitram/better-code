import { execFile } from 'child_process';
import * as os from 'os';
import * as vscode from 'vscode';

interface CpuSnapshot {
  idle: number;
  total: number;
}

interface DiskUsage {
  used: number;
  total: number;
}

type StatusSegmentKey = 'cpu' | 'frequency' | 'memory' | 'disk';

export function startSystemStatusBar(context: vscode.ExtensionContext): void {
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

      const showCpu = configuration.get<boolean>('showCpu', true);
      const showFrequency = configuration.get<boolean>('showFrequency', true);
      const showMemory = configuration.get<boolean>('showMemory', true);
      const showDisk = configuration.get<boolean>('showDisk', true);

      const cpu = showCpu || showFrequency ? getCpuUsage(previousCpu) : null;
      if (cpu) {
        previousCpu = cpu.snapshot;
      }

      const memory = showMemory ? getMemoryUsage() : null;
      const disk = showDisk ? await getDiskUsage(getConfiguredDiskPath()) : null;
      const frequency = showFrequency ? getCpuFrequency() : null;
      const frequencyAvailable = frequency !== null && frequency !== '--';

      const visibleSegments: string[] = [];

      if (showCpu && cpu) {
        visibleSegments.push(getStableSegment('cpu', `$(pulse) ${formatPercent(cpu.percent)}`, segmentWidths));
      }

      if (frequencyAvailable && frequency) {
        visibleSegments.push(getStableSegment('frequency', `$(dashboard) ${frequency}`, segmentWidths));
      }

      if (showMemory && memory) {
        visibleSegments.push(
          getStableSegment('memory', `$(ellipsis) ${formatBytes(memory.used)}/${formatBytes(memory.total)}`, segmentWidths)
        );
      }

      if (showDisk && disk) {
        visibleSegments.push(
          getStableSegment('disk', `$(database) ${formatBytes(disk.used)}/${formatBytes(disk.total)} used`, segmentWidths)
        );
      }

      item.text = visibleSegments.join('    ');

      const tooltipLines: string[] = ['ObniCode system status'];
      if (showCpu && cpu) {
        tooltipLines.push(`CPU usage: ${formatPercent(cpu.percent)}`);
      }
      if (showFrequency) {
        tooltipLines.push(`CPU frequency: ${frequency ?? '--'}`);
      }
      if (showMemory && memory) {
        tooltipLines.push(`RAM used: ${formatBytes(memory.used)} / ${formatBytes(memory.total)}`);
      }
      if (showDisk) {
        tooltipLines.push(disk
          ? `Storage used: ${formatBytes(disk.used)} / ${formatBytes(disk.total)}`
          : 'Storage used: unavailable'
        );
      }
      item.tooltip = tooltipLines.join('\n');

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
      return { idle: snapshot.idle + times.idle, total: snapshot.total + total };
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
    percent: Math.min(100, Math.max(0, percent)),
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
  return { used: total - os.freemem(), total };
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

      resolve({ used: usedBlocks * 1024, total: totalBlocks * 1024 });
    });
  });
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function getStableSegment(
  key: StatusSegmentKey,
  value: string,
  widths: Map<StatusSegmentKey, number>
): string {
  const width = Math.max(widths.get(key) ?? 0, value.length);
  widths.set(key, width);
  return value.padEnd(width, ' ');
}
