/**
 * SQLite database connection using better-sqlite3
 */

import { resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';
import Database from 'better-sqlite3';
import { databasePath } from '../paths.js';

export interface DatabaseConnection {
  db: Database.Database;
  close(): void;
}

export function createDatabaseConnection(): DatabaseConnection {
  const dbPath = databasePath();
  const dbDir = resolve(dbPath, '..');

  // Ensure directory exists
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return {
    db,
    close: () => db.close(),
  };
}

// Lazy singleton
let connection: DatabaseConnection | null = null;

export function getDatabase(): DatabaseConnection {
  if (!connection) {
    connection = createDatabaseConnection();
    runMigrations(connection.db);
  }
  return connection;
}

function runMigrations(db: Database.Database): void {
  const schema = `
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      repo_path TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      model TEXT,
      sdk_agent_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_sessions_ck ON agent_sessions(channel, channel_key);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);

    CREATE TABLE IF NOT EXISTS session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_messages_sid ON session_messages(session_id);

    CREATE TABLE IF NOT EXISTS session_participants (
      session_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (session_id, channel, conversation_id)
    );

    CREATE INDEX IF NOT EXISTS idx_session_participants_conv ON session_participants(channel, conversation_id);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `;

  db.exec(schema);
  migrateAgentSessions(db);
}

function migrateAgentSessions(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(agent_sessions)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'sdk_agent_id')) {
    db.exec('ALTER TABLE agent_sessions ADD COLUMN sdk_agent_id TEXT');
  }
}

export function resetConnection(): void {
  if (connection) {
    connection.close();
    connection = null;
  }
}
