/**
 * Configuration loader - YAML + environment variables
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import yaml from 'js-yaml';
import { z } from 'zod';
import type { AppConfig } from '../models/types.js';

const RepoEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string().default(''),
});

const AppConfigSchema = z.object({
  repos: z.array(RepoEntrySchema).default([]),
  workspace_root: z.string().default(''),
  channels: z.object({
    telegram: z.object({ enabled: z.boolean().default(false) }),
    web: z.object({ enabled: z.boolean().default(true) }),
  }).default({ telegram: { enabled: false }, web: { enabled: true } }),
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.number().default(8080),
  }).default({ host: '0.0.0.0', port: 8080 }),
  sdk: z.object({
    default_model: z.string().default('composer-2.5'),
    max_sessions: z.number().default(5),
  }).default({ default_model: 'composer-2.5', max_sessions: 5 }),
});

type RawConfig = z.infer<typeof AppConfigSchema>;

export interface EnvSettings {
  cursorApiKey: string;
  telegramBotToken: string;
  telegramAllowedUserIds: Set<number>;
  workspaceRoot: string;
  port: number;
  host: string;
}

function loadEnv(): EnvSettings {
  const rawIds = process.env.TELEGRAM_ALLOWED_USER_IDS ?? '';
  const allowedIds = new Set<number>();

  for (const part of rawIds.split(/[\s,]+/)) {
    const num = parseInt(part, 10);
    if (!isNaN(num)) {
      allowedIds.add(num);
    }
  }

  // Only set port/host from env if explicitly provided
  const portStr = process.env.PORT;
  const hostStr = process.env.HOST;

  return {
    cursorApiKey: process.env.CURSOR_API_KEY ?? '',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    telegramAllowedUserIds: allowedIds,
    workspaceRoot: process.env.WORKSPACE_ROOT ?? '',
    port: portStr ? parseInt(portStr, 10) : 0, // 0 means "not set, use config"
    host: hostStr ?? '', // empty means "not set, use config"
  };
}

function resolveWorkspaceRoot(config: RawConfig, env: EnvSettings): string {
  // Priority: env > config > default
  const fromEnv = env.workspaceRoot.trim();
  if (fromEnv) {
    return resolve(fromEnv.replace(/^~/, homedir()));
  }

  const fromConfig = config.workspace_root?.trim();
  if (fromConfig) {
    return resolve(fromConfig.replace(/^~/, homedir()));
  }

  return resolve(homedir(), 'cursor-cp-ws-root');
}

export function loadConfig(): { config: AppConfig; env: EnvSettings } {
  const configPath = process.env.CONFIG_PATH ?? 'config.yaml';
  let raw: RawConfig = AppConfigSchema.parse({});

  if (existsSync(configPath)) {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(content) as Record<string, unknown> | undefined;
    if (parsed) {
      raw = AppConfigSchema.parse(parsed);
    }
  }

  const env = loadEnv();
  const workspaceRoot = resolveWorkspaceRoot(raw, env);

  const config: AppConfig = {
    repos: raw.repos,
    workspaceRoot,
    channels: raw.channels,
    server: {
      host: env.host || raw.server.host,
      port: env.port || raw.server.port,
    },
    sdk: {
      defaultModel: raw.sdk.default_model,
      maxSessions: raw.sdk.max_sessions,
    },
  };

  return { config, env };
}
