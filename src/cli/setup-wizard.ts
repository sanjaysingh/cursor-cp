/**
 * Interactive Setup Wizard
 * First-run configuration for API keys and settings
 */

import { createInterface } from 'readline';
import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

interface WizardAnswers {
  cursorApiKey: string;
  telegramBotToken: string;
  telegramAllowedUsers: string;
  enableTelegram: boolean;
  enableWeb: boolean;
  port: number;
  host: string;
  workspaceRoot: string;
  defaultModel: string;
}

export async function runSetupWizard(dataDir: string): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║         Cursor Control Plane - Setup Wizard              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question: string, defaultValue?: string): Promise<string> => {
    return new Promise((resolve) => {
      const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
      rl.question(prompt, (answer) => {
        resolve(answer.trim() || defaultValue || '');
      });
    });
  };

  const askYesNo = async (question: string, defaultValue = true): Promise<boolean> => {
    const hint = defaultValue ? 'Y/n' : 'y/N';
    const answer = await ask(`${question} (${hint})`);
    if (!answer) return defaultValue;
    return ['y', 'yes', 'true', '1'].includes(answer.toLowerCase());
  };

  try {
    // Required: Cursor API Key
    console.log('Get your Cursor API key from: https://cursor.com/dashboard/cloud-agents\n');

    let cursorApiKey = '';
    while (!cursorApiKey) {
      cursorApiKey = await ask('Cursor API Key (starts with cursor_)');
      if (!cursorApiKey.startsWith('cursor_')) {
        console.log('⚠️  Warning: API key should start with "cursor_"');
        const proceed = await askYesNo('Continue anyway?', false);
        if (!proceed) cursorApiKey = '';
      }
    }

    // Optional: Telegram
    console.log('\n--- Telegram Bot (optional) ---');
    console.log('To enable Telegram, create a bot with @BotFather and get a token.\n');

    const telegramBotToken = await ask('Telegram Bot Token (or leave empty)', '');
    let telegramAllowedUsers = '';
    let enableTelegram = false;

    if (telegramBotToken) {
      telegramAllowedUsers = await ask('Allowed Telegram User IDs (comma-separated)', '');
      enableTelegram = await askYesNo('Enable Telegram channel?', true);
    }

    // Channels
    console.log('\n--- Channels ---');
    const enableWeb = await askYesNo('Enable Web Dashboard?', true);

    // Server settings
    console.log('\n--- Server Settings ---');
    const portStr = await ask('HTTP Port', '8080');
    const port = parseInt(portStr, 10) || 8080;
    const host = await ask('HTTP Host', '0.0.0.0');

    // Workspace
    console.log('\n--- Workspace ---');
    const defaultWorkspace = resolve(homedir(), 'cursor-cp-ws-root');
    const workspaceRoot = await ask('Workspace Directory', defaultWorkspace);

    // Model
    console.log('\n--- Model Settings ---');
    const defaultModel = await ask('Default Model (e.g., composer-2, or empty for Auto)', '');

    // Generate environment file
    const envContent = generateEnvFile({
      cursorApiKey,
      telegramBotToken,
      telegramAllowedUsers,
      enableTelegram,
      enableWeb,
      port,
      host,
      workspaceRoot,
      defaultModel,
    });

    const envPath = resolve(dataDir, '.env');
    writeFileSync(envPath, envContent);

    // Generate config.yaml
    const configContent = generateConfigFile({
      enableTelegram,
      enableWeb,
      port,
      host,
      workspaceRoot,
      defaultModel,
    });

    const configPath = resolve(dataDir, 'config.yaml');
    writeFileSync(configPath, configContent);

    console.log('\n✅ Configuration saved!\n');
    console.log(`Environment file: ${envPath}`);
    console.log(`Config file: ${configPath}`);
    console.log('\nTo start the server:');
    console.log('  npm run dev');
    console.log('  # or');
    console.log('  npm start\n');
  } finally {
    rl.close();
  }
}

function generateEnvFile(answers: WizardAnswers): string {
  const lines: string[] = [
    '# Cursor Control Plane Environment Configuration',
    `# Generated on ${new Date().toISOString()}`,
    '',
    '# Required: Cursor API Key',
    `CURSOR_API_KEY=${answers.cursorApiKey}`,
    '',
  ];

  if (answers.telegramBotToken) {
    lines.push('# Telegram Bot Configuration');
    lines.push(`TELEGRAM_BOT_TOKEN=${answers.telegramBotToken}`);
    if (answers.telegramAllowedUsers) {
      lines.push(`TELEGRAM_ALLOWED_USER_IDS=${answers.telegramAllowedUsers}`);
    }
    lines.push('');
  }

  lines.push('# Server Configuration');
  lines.push(`PORT=${answers.port}`);
  lines.push(`HOST=${answers.host}`);
  lines.push(`WORKSPACE_ROOT=${answers.workspaceRoot}`);
  lines.push('');

  lines.push('# Logging');
  lines.push('LOG_LEVEL=info');

  return lines.join('\n');
}

interface ConfigFileAnswers {
  enableTelegram: boolean;
  enableWeb: boolean;
  port: number;
  host: string;
  workspaceRoot: string;
  defaultModel: string;
}

function generateConfigFile(answers: ConfigFileAnswers): string {
  return `# Cursor Control Plane Configuration
# Generated on ${new Date().toISOString()}

# Repositories to show in dropdown (optional)
repos: []

# Workspace directory
workspace_root: "${answers.workspaceRoot}"

# Feature toggles
channels:
  telegram:
    enabled: ${answers.enableTelegram}
  web:
    enabled: ${answers.enableWeb}

# Server settings
server:
  host: ${answers.host}
  port: ${answers.port}

# SDK settings
sdk:
  default_model: "${answers.defaultModel || 'composer-2'}"
  max_sessions: 5
`;
}

export function checkNeedsSetup(dataDir: string): boolean {
  // Check if .env file exists and has valid API key
  const envPath = resolve(dataDir, '.env');

  if (!existsSync(envPath)) {
    return true;
  }

  try {
    const envContent = readFileSync(envPath, 'utf-8');

    // Check for CURSOR_API_KEY line
    const apiKeyMatch = envContent.match(/CURSOR_API_KEY=(.+)/);
    if (!apiKeyMatch) {
      return true;
    }

    const apiKeyValue = apiKeyMatch[1].trim();

    // Check if it's a valid key (not empty, not placeholder)
    const hasValidKey = apiKeyValue &&
      !apiKeyValue.startsWith('your_') &&
      !apiKeyValue.startsWith('CURSOR_API_KEY');

    return !hasValidKey;
  } catch {
    return true;
  }
}

import { readFileSync } from 'fs';

export async function ensureSetup(dataDir: string): Promise<void> {
  // Skip setup wizard in CI environments - use environment variables instead
  if (process.env.CI === 'true') {
    return;
  }
  if (checkNeedsSetup(dataDir)) {
    await runSetupWizard(dataDir);
  }
}
