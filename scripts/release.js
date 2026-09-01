#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');

const projectRoot = path.resolve(__dirname, '..');
const packagePath = path.join(projectRoot, 'package.json');
const lockfilePath = path.join(projectRoot, 'package-lock.json');
const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function main() {
  ensureCleanWorkingTree();

  const pkg = readJson(packagePath);
  const releaseType = await askReleaseType();
  const nextVersion = incrementVersion(pkg.version, releaseType);
  const tagName = `v${nextVersion}`;

  console.log(`\nPreparing ${releaseType} release ${tagName}.`);
  await confirmChangelog(nextVersion);
  ensureChangelogEntry(nextVersion);
  ensureTagDoesNotExist(tagName);

  updateVersions(nextVersion);
  run(npmCommand, ['run', 'build:vsix']);
  run('git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
  run('git', ['commit', '-m', `chore(release): ${tagName}`]);
  run('git', ['tag', '-a', tagName, '-m', `Release ${tagName}`]);

  console.log(`\nRelease ${tagName} created successfully. Push the commit and tag when ready:`);
  console.log('  git push');
  console.log(`  git push origin ${tagName}`);
}

async function askReleaseType() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    while (true) {
      const answer = (await rl.question('Release type (patch, minor, major): ')).trim().toLowerCase();
      if (['patch', 'minor', 'major'].includes(answer)) {
        return answer;
      }

      console.log('Please enter patch, minor, or major.');
    }
  } finally {
    rl.close();
  }
}

async function confirmChangelog(version) {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const answer = (await rl.question(
      `Is CHANGELOG.md correct and ready for version ${version}? [y/N]: `
    )).trim().toLowerCase();

    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Release cancelled. Update CHANGELOG.md before running the release again.');
    }
  } finally {
    rl.close();
  }
}

function ensureCleanWorkingTree() {
  const result = runCapture('git', ['status', '--porcelain']);
  if (result.trim()) {
    throw new Error('Release requires a clean Git working tree. Commit or stash your changes first.');
  }
}

function ensureChangelogEntry(version) {
  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const versionPattern = new RegExp(`^## \\[${escapeRegex(version)}\\](?:\\s|$)`, 'm');

  if (!versionPattern.test(changelog)) {
    throw new Error(`CHANGELOG.md does not contain a heading for version ${version}.`);
  }
}

function ensureTagDoesNotExist(tagName) {
  const tag = runCapture('git', ['tag', '--list', tagName]).trim();
  if (tag) {
    throw new Error(`Git tag ${tagName} already exists.`);
  }
}

function updateVersions(version) {
  const pkg = readJson(packagePath);
  const lockfile = readJson(lockfilePath);

  pkg.version = version;
  lockfile.version = version;

  if (!lockfile.packages || !lockfile.packages['']) {
    throw new Error('package-lock.json does not contain root package metadata.');
  }

  lockfile.packages[''].version = version;

  writeJson(packagePath, pkg);
  writeJson(lockfilePath, lockfile);
}

function incrementVersion(version, releaseType) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) {
    throw new Error(`Version "${version}" must use the X.Y.Z format.`);
  }

  const [major, minor, patch] = match.slice(1).map(Number);

  if (releaseType === 'major') {
    return `${major + 1}.0.0`;
  }

  if (releaseType === 'minor') {
    return `${major}.${minor + 1}.0`;
  }

  return `${major}.${minor}.${patch + 1}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
  }

  return result.stdout;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

main().catch((error) => {
  console.error(`\nRelease failed: ${error.message}`);
  process.exitCode = 1;
});
