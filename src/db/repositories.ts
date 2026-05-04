/**
 * Repository layer for database operations
 */

import type Database from 'better-sqlite3';
import type {
  Session,
  SessionMessage,
  SessionParticipant,
} from '../models/types.js';

export class SessionRepository {
  constructor(private db: Database.Database) {}

  private rowToSession(row: unknown): Session {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      channel: r.channel as string,
      channelKey: r.channel_key as string,
      repoPath: r.repo_path as string,
      repoName: (r.repo_path as string)?.split('/').pop() ?? '',
      title: r.title as string,
      status: r.status as Session['status'],
      activity: 'idle',
      model: r.model as string | null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      closedAt: r.closed_at as string | null,
      errorMessage: null,
      outputPreview: '',
    };
  }

  count(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM agent_sessions');
    return (stmt.get() as { count: number }).count;
  }

  findById(id: string): Session | undefined {
    const stmt = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?');
    const row = stmt.get(id);
    return row ? this.rowToSession(row) : undefined;
  }

  findOpenByChannel(channel: string, channelKey: string, repoPath: string): Session | undefined {
    const stmt = this.db.prepare(
      'SELECT * FROM agent_sessions WHERE channel = ? AND channel_key = ? AND repo_path = ? AND status = ?'
    );
    const row = stmt.get(channel, channelKey, repoPath, 'open');
    return row ? this.rowToSession(row) : undefined;
  }

  listByChannel(channel: string, channelKey: string, includeClosed = true, limit = 100): Session[] {
    const sql = includeClosed
      ? 'SELECT * FROM agent_sessions WHERE channel = ? AND channel_key = ? ORDER BY updated_at DESC LIMIT ?'
      : 'SELECT * FROM agent_sessions WHERE channel = ? AND channel_key = ? AND status = ? ORDER BY updated_at DESC LIMIT ?';

    const stmt = this.db.prepare(sql);
    const rows = includeClosed
      ? (stmt.all(channel, channelKey, limit) as unknown[])
      : (stmt.all(channel, channelKey, 'open', limit) as unknown[]);

    return rows.map((r) => this.rowToSession(r));
  }

  listAll(includeClosed = true, limit = 100): Session[] {
    const sql = includeClosed
      ? 'SELECT * FROM agent_sessions ORDER BY updated_at DESC LIMIT ?'
      : 'SELECT * FROM agent_sessions WHERE status = ? ORDER BY updated_at DESC LIMIT ?';

    const stmt = this.db.prepare(sql);
    const rows = includeClosed
      ? (stmt.all(limit) as unknown[])
      : (stmt.all('open', limit) as unknown[]);

    return rows.map((r) => this.rowToSession(r));
  }

  insert(session: Omit<Session, 'repoName' | 'activity' | 'errorMessage' | 'outputPreview'>): void {
    const stmt = this.db.prepare(
      'INSERT INTO agent_sessions (id, channel, channel_key, repo_path, title, status, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(
      session.id,
      session.channel,
      session.channelKey,
      session.repoPath,
      session.title,
      session.status,
      session.model,
      session.createdAt,
      session.updatedAt
    );
  }

  updateStatus(id: string, status: Session['status']): void {
    const stmt = this.db.prepare(
      'UPDATE agent_sessions SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?'
    );
    const now = new Date().toISOString();
    stmt.run(status, now, status === 'closed' ? now : null, id);
  }

  updateModel(id: string, model: string): void {
    const stmt = this.db.prepare('UPDATE agent_sessions SET model = ?, updated_at = ? WHERE id = ?');
    stmt.run(model, new Date().toISOString(), id);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM agent_sessions WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteAll(): number {
    const stmt = this.db.prepare('DELETE FROM agent_sessions');
    const result = stmt.run();
    return result.changes;
  }

  touch(id: string): void {
    const stmt = this.db.prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?');
    stmt.run(new Date().toISOString(), id);
  }
}

export class MessageRepository {
  constructor(private db: Database.Database) {}

  private rowToMessage(row: unknown): SessionMessage {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as number,
      sessionId: r.session_id as string,
      role: r.role as SessionMessage['role'],
      content: r.content as string,
      createdAt: r.created_at as string,
    };
  }

  listBySession(sessionId: string, limit = 500): SessionMessage[] {
    const stmt = this.db.prepare(
      'SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
    );
    const rows = stmt.all(sessionId, limit) as unknown[];
    return rows.map((r) => this.rowToMessage(r));
  }

  insert(sessionId: string, role: SessionMessage['role'], content: string): void {
    const stmt = this.db.prepare(
      'INSERT INTO session_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    );
    stmt.run(sessionId, role, content, new Date().toISOString());
  }

  deleteBySession(sessionId: string): void {
    const stmt = this.db.prepare('DELETE FROM session_messages WHERE session_id = ?');
    stmt.run(sessionId);
  }
}

export class ParticipantRepository {
  constructor(private db: Database.Database) {}

  private rowToParticipant(row: unknown): SessionParticipant {
    const r = row as Record<string, unknown>;
    return {
      sessionId: r.session_id as string,
      channel: r.channel as string,
      conversationId: r.conversation_id as string,
      joinedAt: r.joined_at as string,
    };
  }

  listBySession(sessionId: string): SessionParticipant[] {
    const stmt = this.db.prepare('SELECT * FROM session_participants WHERE session_id = ?');
    const rows = stmt.all(sessionId) as unknown[];
    return rows.map((r) => this.rowToParticipant(r));
  }

  listByConversation(channel: string, conversationId: string, openOnly = true): string[] {
    if (openOnly) {
      const stmt = this.db.prepare(
        `SELECT p.session_id
         FROM session_participants p
         JOIN agent_sessions s ON p.session_id = s.id
         WHERE p.channel = ? AND p.conversation_id = ? AND s.status = ?`
      );
      const rows = stmt.all(channel, conversationId, 'open') as { session_id: string }[];
      return rows.map((r) => r.session_id);
    }

    const stmt = this.db.prepare(
      'SELECT session_id FROM session_participants WHERE channel = ? AND conversation_id = ?'
    );
    const rows = stmt.all(channel, conversationId) as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }

  ensure(participant: SessionParticipant): void {
    const stmt = this.db.prepare(
      `INSERT INTO session_participants (session_id, channel, conversation_id, joined_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, channel, conversation_id) DO NOTHING`
    );
    stmt.run(participant.sessionId, participant.channel, participant.conversationId, participant.joinedAt);
  }

  deleteBySession(sessionId: string): void {
    const stmt = this.db.prepare('DELETE FROM session_participants WHERE session_id = ?');
    stmt.run(sessionId);
  }
}

export class SettingsRepository {
  constructor(private db: Database.Database) {}

  get(key: string): string | undefined {
    const stmt = this.db.prepare('SELECT value FROM app_settings WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    const stmt = this.db.prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
    );
    stmt.run(key, value, value);
  }

  delete(key: string): void {
    const stmt = this.db.prepare('DELETE FROM app_settings WHERE key = ?');
    stmt.run(key);
  }
}
