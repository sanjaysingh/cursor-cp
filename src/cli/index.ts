/**
 * CLI Commands
 */

import { runSetupWizard, ensureSetup } from './setup-wizard.js';
import { runServiceCommand } from '../service/service-control.js';
import { resolve } from 'path';
import { homedir } from 'os';

const DATA_DIR = resolve(homedir(), '.config', 'cursor-cp');

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async setup() {
    await runSetupWizard(DATA_DIR);
  },

  async serve() {
    await ensureSetup(DATA_DIR);
    // Import and start server
    await import('../index.js');
  },

  async start() {
    await commands.serve([]);
  },

  async config() {
    const envPath = resolve(DATA_DIR, '.env');
    const configPath = resolve(DATA_DIR, 'config.yaml');

    console.log('Configuration files:');
    console.log(`  Environment: ${envPath}`);
    console.log(`  Config: ${configPath}`);
    console.log();

    // Print current config
    try {
      const { loadConfig } = await import('../config/loader.js');
      const { config, env } = loadConfig();

      console.log('Current Settings:');
      console.log(`  Workspace: ${config.workspaceRoot}`);
      console.log(`  Server: ${config.server.host}:${config.server.port}`);
      console.log(`  Default Model: ${config.sdk.defaultModel}`);
      console.log(`  Telegram: ${config.channels.telegram.enabled ? 'enabled' : 'disabled'}`);
      console.log(`  Web: ${config.channels.web.enabled ? 'enabled' : 'disabled'}`);
      console.log(`  API Key: ${env.cursorApiKey ? 'configured' : 'NOT SET'}`);
    } catch (err) {
      console.log('Could not load configuration:', err instanceof Error ? err.message : String(err));
    }
  },

  async service(args: string[]) {
    const command = args[0] || 'status';
    await runServiceCommand(command);
  },

  async help() {
    console.log(`
Cursor Control Plane CLI

Commands:
  setup          Run interactive setup wizard
  serve          Start the server (runs setup if needed)
  start          Alias for serve
  config         Show current configuration
  service        Manage background service (install/start/stop/restart/status/uninstall)
  help           Show this help message

Service Commands:
  cursor-cp service install    Install as system service
  cursor-cp service start      Start background service
  cursor-cp service stop       Stop background service
  cursor-cp service restart    Restart background service
  cursor-cp service status     Show service status
  cursor-cp service uninstall  Remove system service

Examples:
  cursor-cp setup
  cursor-cp serve
  cursor-cp service install
  cursor-cp config

Configuration directory: ${DATA_DIR}
`);
  },
};

export async function runCLI(args: string[]): Promise<void> {
  const command = args[0] || 'serve';

  if (command === 'help' || command === '--help' || command === '-h') {
    await commands.help([]);
    return;
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    console.log('0.1.0');
    return;
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.log('Run "cursor-cp help" for available commands.');
    process.exit(1);
  }

  await handler(args.slice(1));
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runCLI(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
