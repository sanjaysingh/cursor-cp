/**
 * `cursor-cp doctor` — checks for common configuration problems.
 */

import { createServer } from 'net';
import { userConfigPath } from '../config/home.js';
import { loadConfig } from '../config/loader.js';
import { validateApiKey } from './setup.js';
import { ServiceController } from '../service/service-control.js';

type Status = 'pass' | 'warn' | 'fail';

interface Check {
  status: Status;
  message: string;
}

const SYMBOL: Record<Status, string> = {
  pass: '[ok]',
  warn: '[warn]',
  fail: '[fail]',
};

const MIN_NODE_MAJOR = 20;

function checkNode(): Check {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (major >= MIN_NODE_MAJOR) {
    return { status: 'pass', message: `Node.js ${process.version}` };
  }
  return { status: 'fail', message: `Node.js ${process.version} (requires >= ${MIN_NODE_MAJOR})` };
}

function checkConfigFile(): Check {
  const { overridePaths } = loadConfig();
  if (overridePaths.length > 0) {
    return { status: 'pass', message: `Config overrides: ${overridePaths.join(', ')}` };
  }
  return {
    status: 'fail',
    message: `No config.yaml found — run \`cursor-cp setup\` or copy config.default.yaml to ${userConfigPath()}`,
  };
}

function checkApiKey(config: ReturnType<typeof loadConfig>['config']): Check {
  const result = validateApiKey(config.cursorApiKey);
  if (!result.ok) {
    return { status: 'fail', message: 'cursor.api_key is not set — run `cursor-cp setup`' };
  }
  if (result.warning) {
    return { status: 'warn', message: `cursor.api_key set, but ${result.warning}` };
  }
  return { status: 'pass', message: 'cursor.api_key is set' };
}

function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host === '0.0.0.0' ? undefined : host);
  });
}

async function checkPort(): Promise<Check> {
  const { config } = loadConfig();
  const { host, port } = config.server;
  const free = await isPortFree(host, port);
  if (free) {
    return { status: 'pass', message: `Port ${port} is available` };
  }
  return {
    status: 'warn',
    message: `Port ${port} is in use (cursor-cp may already be running, or change server.port in config.yaml)`,
  };
}

async function checkGitHubCli(): Promise<Check> {
  try {
    const { execa } = await import('execa');
    await execa('gh', ['--version'], { timeout: 5000 });
    return { status: 'pass', message: 'GitHub CLI (gh) is installed' };
  } catch {
    return {
      status: 'warn',
      message: 'GitHub CLI (gh) not found — repo browsing/cloning will be disabled',
    };
  }
}

function checkDaemon(): Check {
  const controller = new ServiceController();
  if (!controller.isInstalled()) {
    return {
      status: 'warn',
      message: 'Background daemon not enabled — run `cursor-cp setup` or `cursor-cp daemon enable`',
    };
  }
  const status = controller.getStatus();
  if (status === 'running') {
    return { status: 'pass', message: 'Background daemon is enabled and running' };
  }
  return { status: 'warn', message: `Background daemon is enabled but ${status}` };
}

export async function runDoctor(): Promise<void> {
  const { config } = loadConfig();

  const checks: Check[] = [
    checkNode(),
    checkConfigFile(),
    checkApiKey(config),
    await checkPort(),
    await checkGitHubCli(),
    checkDaemon(),
  ];

  console.log('');
  console.log('cursor-cp doctor');
  console.log('');
  for (const check of checks) {
    console.log(`  ${SYMBOL[check.status].padEnd(7)} ${check.message}`);
  }
  console.log('');

  const failed = checks.filter((c) => c.status === 'fail').length;
  if (failed > 0) {
    console.log(`${failed} issue(s) need attention. Run \`cursor-cp setup\` to fix configuration.`);
    process.exitCode = 1;
  } else {
    console.log('No blocking issues found.');
  }
}
