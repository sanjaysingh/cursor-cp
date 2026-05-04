/**
 * Tests for repository layer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { unlinkSync } from 'fs';
import {
  SessionRepository,
  MessageRepository,
  ParticipantRepository,
  SettingsRepository,
} from './repositories.js';
import type { Session } from '../models/types.js';

describe('Repositories', () => {
  let db: Database.Database;
  let sessions: SessionRepository;
  let messages: MessageRepository;
  let participants: ParticipantRepository;
  let settings: SettingsRepository;
  let dbPath: string;

  beforeEach(() => {
    dbPath = resolve(tmpdir(), `test-${Date.now()}.db`);
    db = new Database(dbPath);

    // Run migrations
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        channel_key TEXT NOT NULL,
        repo_path TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_participants (
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (session_id, channel, conversation_id)
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
    `);

    sessions = new SessionRepository(db);
    messages = new MessageRepository(db);
    participants = new ParticipantRepository(db);
    settings = new SettingsRepository(db);
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(dbPath);
    } catch { /* ignore */ }
  });

  describe('SessionRepository', () => {
    it('should insert and find a session', () => {
      const session: Omit<Session, 'repoName' | 'activity' | 'errorMessage' | 'outputPreview'> = {
        id: 'test-1',
        channel: 'web',
        channelKey: 'web:default',
        repoPath: '/tmp/repo',
        title: 'Test Session',
        status: 'open',
        model: 'composer-2',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        closedAt: null,
      };

      sessions.insert(session);

      const found = sessions.findById('test-1');
      expect(found).toBeDefined();
      expect(found?.id).toBe('test-1');
      expect(found?.channel).toBe('web');
      expect(found?.repoName).toBe('repo');
    });

    it('should list sessions by channel', () => {
      const now = new Date().toISOString();

      sessions.insert({
        id: 's1',
        channel: 'web',
        channelKey: 'key1',
        repoPath: '/r1',
        title: 'Session 1',
        status: 'open',
        model: null,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      });

      sessions.insert({
        id: 's2',
        channel: 'web',
        channelKey: 'key2',
        repoPath: '/r2',
        title: 'Session 2',
        status: 'open',
        model: null,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      });

      const list1 = sessions.listByChannel('web', 'key1', false);
      expect(list1).toHaveLength(1);
      expect(list1[0].id).toBe('s1');
    });

    it('should update session status', () => {
      const now = new Date().toISOString();

      sessions.insert({
        id: 's1',
        channel: 'web',
        channelKey: 'key1',
        repoPath: '/r1',
        title: 'Session',
        status: 'open',
        model: null,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      });

      sessions.updateStatus('s1', 'closed');

      const found = sessions.findById('s1');
      expect(found?.status).toBe('closed');
      expect(found?.closedAt).toBeDefined();
    });

    it('should count sessions', () => {
      expect(sessions.count()).toBe(0);

      const now = new Date().toISOString();
      sessions.insert({
        id: 's1',
        channel: 'web',
        channelKey: 'key1',
        repoPath: '/r1',
        title: 'Session',
        status: 'open',
        model: null,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      });

      expect(sessions.count()).toBe(1);
    });
  });

  describe('MessageRepository', () => {
    it('should insert and list messages', () => {
      messages.insert('session-1', 'user', 'Hello');
      messages.insert('session-1', 'assistant', 'Hi there!');
      messages.insert('session-1', 'user', 'How are you?');

      const msgs = messages.listBySession('session-1');
      expect(msgs).toHaveLength(3);
      expect(msgs[0].role).toBe('user');
      expect(msgs[1].role).toBe('assistant');
    });

    it('should respect limit', () => {
      for (let i = 0; i < 10; i++) {
        messages.insert('session-1', 'user', `Message ${i}`);
      }

      const msgs = messages.listBySession('session-1', 5);
      expect(msgs).toHaveLength(5);
    });
  });

  describe('ParticipantRepository', () => {
    it('should ensure and list participants', () => {
      participants.ensure({
        sessionId: 's1',
        channel: 'web',
        conversationId: 'user-1',
        joinedAt: new Date().toISOString(),
      });

      participants.ensure({
        sessionId: 's1',
        channel: 'telegram',
        conversationId: 'chat-1',
        joinedAt: new Date().toISOString(),
      });

      const list = participants.listBySession('s1');
      expect(list).toHaveLength(2);
    });

    it('should not duplicate on ensure', () => {
      const data = {
        sessionId: 's1',
        channel: 'web',
        conversationId: 'user-1',
        joinedAt: new Date().toISOString(),
      };

      participants.ensure(data);
      participants.ensure(data);

      const list = participants.listBySession('s1');
      expect(list).toHaveLength(1);
    });
  });

  describe('SettingsRepository', () => {
    it('should set and get settings', () => {
      settings.set('default_model', 'composer-2');

      expect(settings.get('default_model')).toBe('composer-2');
      expect(settings.get('missing')).toBeUndefined();
    });

    it('should update existing settings', () => {
      settings.set('key', 'value1');
      settings.set('key', 'value2');

      expect(settings.get('key')).toBe('value2');
    });
  });
});
