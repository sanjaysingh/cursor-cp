/**
 * Load environment variables from the project root .env file
 */

import { config as dotenvLoad } from 'dotenv';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

export function getProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

export function getEnvFilePath(): string {
  return resolve(getProjectRoot(), '.env');
}

export function loadEnvFiles(): void {
  const envPath = getEnvFilePath();
  if (existsSync(envPath)) {
    dotenvLoad({ path: envPath });
  }
}

export function requireCursorApiKey(): string {
  loadEnvFiles();

  const apiKey = process.env.CURSOR_API_KEY?.trim() ?? '';
  if (!apiKey || apiKey.startsWith('your_')) {
    console.error('Error: CURSOR_API_KEY is required');
    console.error('');
    console.error('Copy .env.example to .env in the project root and set your API key:');
    console.error(`  ${getEnvFilePath()}`);
    console.error('');
    console.error('Get a key from: https://cursor.com/dashboard/cloud-agents');
    process.exit(1);
  }

  return apiKey;
}
