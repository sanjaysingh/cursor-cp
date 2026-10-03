/**
 * Session Manager
 * Orchestrates sessions, database, and agent service
 */

import { randomUUID } from 'crypto';
import { basename } from 'path';
import type { Session, IncomingMessage } from '../models/types.js';
import type { SessionRepository, MessageRepository, ParticipantRepository, SettingsRepository } from '../db/repositories.js';
import { AgentService, type AgentRunResult } from './agent-service.js';
import { EventBus } from './events.js';
import type { Channel, ChannelRegistry } from '../channels/base.js';
import { logger } from '../util/logger.js';

export class SessionLimitError extends Error {
  constructor(max: number) {
    super(`Maximum ${max} sessions reached. Close one before creating a new session.`);
    this.name = 'SessionLimitError';
  }
}

interface SessionManagerOptions {
  repositories: {
    sessions: SessionRepository;
    messages: MessageRepository;
    participants: ParticipantRepository;
    settings: SettingsRepository;
  };
  agentService: AgentService;
  eventBus: EventBus;
  registry: ChannelRegistry;
  maxSessions: number;
  defaultModel: string;
}

interface ManagedSession extends Session {
  channelInstance?: Channel;
}

export class SessionManager {
  private sessions: SessionRepository;
  private messages: MessageRepository;
  private participants: ParticipantRepository;
  private settings: SettingsRepository;
  private agentService: AgentService;
  private eventBus: EventBus;
  private registry: ChannelRegistry;
  private maxSessions: number;
  private defaultModel: string;
  private managedSessions: Map<string, ManagedSession> = new Map();
  /** Serializes agent sends per session to avoid concurrent SDK runs. */
  private sessionLocks = new Map<string, Promise<void>>();

  constructor(options: SessionManagerOptions) {
    this.sessions = options.repositories.sessions;
    this.messages = options.repositories.messages;
    this.participants = options.repositories.participants;
    this.settings = options.repositories.settings;
    this.agentService = options.agentService;
    this.eventBus = options.eventBus;
    this.registry = options.registry;
    this.maxSessions = options.maxSessions;
    this.defaultModel = options.defaultModel;

    this.agentService.onStream((sessionId, chunk) => {
      if (chunk.type === 'text') {
        void this.handleStreamChunk(sessionId, chunk.text);
      }
      void this.publishProgress(sessionId, chunk);
    });

    // Fire-and-forget. Awaiting this inside the SDK stream stalls the run.
    this.agentService.onQuestion((sessionId, question) => {
      this.handleAgentQuestion(sessionId, question);
    });
  }

  hasActiveRun(sessionId: string): boolean {
    return this.agentService.hasActiveRun(sessionId);
  }

  /**
   * While a run is streaming, Cursor accepts more input via run.steer().
   * Returns true when the live turn took the text. Otherwise the caller
   * should send it as its own prompt after the current one finishes.
   */
  async offerToActiveRun(
    sessionId: string,
    text: string,
    participantChannel?: string,
    participantConversationId?: string
  ): Promise<boolean> {
    if (!this.agentService.hasActiveRun(sessionId)) return false;

    const steered = await this.agentService.steerActiveRun(sessionId, text);
    if (!steered) return false;

    if (participantChannel && participantConversationId) {
      this.participants.ensure({
        sessionId,
        channel: participantChannel,
        conversationId: participantConversationId,
        joinedAt: new Date().toISOString(),
      });
    }
    this.messages.insert(sessionId, 'user', text);
    this.sessions.touch(sessionId);
    return true;
  }

  /**
   * Surface an SDK `request` event. The first real answer wins and is steered
   * into the live run. Empty timeout results are ignored so we don't inject
   * a fake "Continue" and start another turn.
   */
  private handleAgentQuestion(
    sessionId: string,
    question: { question: string; options: string[] }
  ): void {
    void this.askParticipants(sessionId, question).catch((err) => {
      logger.error({ err, sessionId }, 'Error handling agent question');
    });
  }

  private async askParticipants(
    sessionId: string,
    question: { question: string; options: string[] }
  ): Promise<void> {
    const session = this.managedSessions.get(sessionId);
    if (!session) return;

    session.activity = 'waiting_user';
    await this.eventBus.emit({
      type: 'session_updated',
      session: this.toPublicSession(session),
    });

    const participants = this.participants.listBySession(sessionId);
    let applied = false;

    const waits = participants.map(async (participant) => {
      const channel = this.registry.get(participant.channel);
      if (!channel) return;

      let answer = '';
      try {
        answer = await channel.askQuestion(
          participant.conversationId,
          question.question,
          question.options,
          { sessionId, conversationId: participant.conversationId }
        );
      } catch (err) {
        logger.warn({ err, sessionId, channel: participant.channel }, 'askQuestion failed');
        return;
      }

      if (applied || !answer.trim()) return;
      applied = true;
      session.activity = 'running';
      await this.eventBus.emit({
        type: 'session_updated',
        session: this.toPublicSession(session),
      });
      await this.applyUserInput(sessionId, answer, participant.channel, participant.conversationId);
    });

    await Promise.all(waits);
  }

  private async applyUserInput(
    sessionId: string,
    answer: string,
    channel: string,
    conversationId: string
  ): Promise<void> {
    const outcome = await this.agentService.submitUserInput(sessionId, answer);
    if (outcome === 'send-now') {
      await this.sendSessionMessage(sessionId, answer, channel, conversationId);
      return;
    }

    this.participants.ensure({
      sessionId,
      channel,
      conversationId,
      joinedAt: new Date().toISOString(),
    });
    this.messages.insert(sessionId, 'user', answer);
    this.sessions.touch(sessionId);
  }

  private async handleStreamChunk(sessionId: string, text: string): Promise<void> {
    const session = this.managedSessions.get(sessionId);
    if (!session) return;

    // Update output buffer
    session.outputPreview = (session.outputPreview + text).slice(-4000);

    // Emit to event bus for real-time streaming
    await this.eventBus.emit({
      type: 'agent_stream',
      session_id: sessionId,
      text,
    });

    // Update session in DB
    this.sessions.touch(sessionId);
  }

  private async publishProgress(
    sessionId: string,
    chunk: { text: string; type: 'text' | 'tool' | 'error' | 'thinking' | 'status' }
  ): Promise<void> {
    const session = this.managedSessions.get(sessionId);
    if (!session) return;

    const preview = session.outputPreview.trim();
    let line = '';
    if (chunk.type === 'text') {
      line = preview;
    } else if (!preview && chunk.text.trim()) {
      line = chunk.type === 'tool' ? `⏳ Using ${chunk.text}…` : `⏳ ${chunk.text}`;
    }
    if (!line) return;

    const participants = this.participants.listBySession(sessionId);
    for (const participant of participants) {
      if (participant.channel === 'web') continue;
      const channel = this.registry.get(participant.channel);
      if (!channel?.updateProgress) continue;
      try {
        await channel.updateProgress(participant.conversationId, line);
      } catch (err) {
        logger.warn(
          { err, sessionId, channel: participant.channel },
          'Failed to publish run progress'
        );
      }
    }
  }

  private terminalText(result: AgentRunResult): string {
    const text = result.text.trim();
    if (result.success) {
      return text || 'The agent finished without a text reply.';
    }
    const error = result.error?.trim() || 'The agent stopped without a text reply.';
    return text ? `${text}\n\n${error}` : error;
  }

  /**
   * Send assistant output to non-web participants (Telegram, etc.).
   * Web clients receive real-time chunks via agent_stream on the event bus.
   */
  private async deliverToParticipants(sessionId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const participants = this.participants.listBySession(sessionId);
    const failures: unknown[] = [];

    for (const participant of participants) {
      if (participant.channel === 'web') continue;

      const channel = this.registry.get(participant.channel);
      if (!channel) {
        const err = new Error(`No channel registered for ${participant.channel}`);
        logger.warn(
          { sessionId, channel: participant.channel },
          'No channel registered for participant delivery'
        );
        failures.push(err);
        continue;
      }

      try {
        await channel.sendMessage(participant.conversationId, trimmed);
        logger.info(
          {
            sessionId,
            channel: participant.channel,
            conversationId: participant.conversationId,
            chars: trimmed.length,
          },
          'Delivered assistant response to participant'
        );
      } catch (err) {
        logger.error(
          { err, sessionId, channel: participant.channel, conversationId: participant.conversationId },
          'Failed to deliver assistant response to participant'
        );
        failures.push(err);
      }
    }

    if (failures.length > 0) {
      const first = failures[0];
      throw first instanceof Error ? first : new Error(String(first));
    }
  }

  /**
   * Ensure the Cursor SDK agent exists in memory (resume after restart, or create).
   */
  private async ensureAgentReady(session: Session): Promise<Session> {
    let managed = this.managedSessions.get(session.id);
    if (!managed) {
      managed = { ...session };
      this.managedSessions.set(session.id, managed);
    } else {
      managed.sdkAgentId = session.sdkAgentId ?? managed.sdkAgentId;
      managed.repoPath = session.repoPath || managed.repoPath;
      managed.model = session.model ?? managed.model;
    }

    if (this.agentService.getSession(session.id)) {
      return managed;
    }

    const workspacePath = managed.repoPath || process.cwd();
    managed.activity = 'connecting';
    managed.errorMessage = null;

    try {
      if (managed.sdkAgentId) {
        try {
          const agentSession = await this.agentService.resumeSession(
            session.id,
            managed.sdkAgentId,
            workspacePath,
            managed.model
          );
          managed.sdkAgentId = agentSession.sdkAgentId;
          this.sessions.updateSdkAgentId(session.id, agentSession.sdkAgentId);
          managed.activity = 'idle';
          return managed;
        } catch (err) {
          logger.warn(
            { err, sessionId: session.id, sdkAgentId: managed.sdkAgentId },
            'Agent resume failed, creating new SDK agent'
          );
        }
      }

      const agentSession = await this.agentService.createSession(
        session.id,
        workspacePath,
        managed.model
      );
      managed.sdkAgentId = agentSession.sdkAgentId;
      this.sessions.updateSdkAgentId(session.id, agentSession.sdkAgentId);
      managed.activity = 'idle';
      return managed;
    } catch (err) {
      managed.activity = 'error';
      managed.errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, sessionId: session.id }, 'Failed to ensure agent session');
      throw err;
    }
  }

  async createSession(
    channel: string,
    channelKey: string,
    repoPath: string,
    title: string,
    model?: string | null
  ): Promise<Session> {
    // Check session limit
    const count = this.sessions.count();
    if (count >= this.maxSessions) {
      throw new SessionLimitError(this.maxSessions);
    }

    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const effectiveModel = model || this.getDefaultModel();

    const session: Session = {
      id: sessionId,
      channel,
      channelKey,
      repoPath: repoPath || '',
      repoName: basename(repoPath || 'no-repo'),
      title: title || basename(repoPath || 'Session'),
      status: 'open',
      activity: 'idle',
      model: effectiveModel,
      sdkAgentId: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      errorMessage: null,
      outputPreview: '',
    };

    this.sessions.insert(session);
    this.managedSessions.set(sessionId, session);

    logger.info(
      { sessionId, channel, channelKey, repoPath: repoPath || process.cwd(), model: effectiveModel },
      'Session created'
    );

    // Add creator as participant
    this.participants.ensure({
      sessionId,
      channel,
      conversationId: channelKey,
      joinedAt: now,
    });

    // Create agent session
    try {
      session.activity = 'connecting';
      const agentSession = await this.agentService.createSession(
        sessionId,
        repoPath || process.cwd(),
        effectiveModel
      );
      session.sdkAgentId = agentSession.sdkAgentId;
      this.sessions.updateSdkAgentId(sessionId, agentSession.sdkAgentId);
      session.activity = 'idle';
    } catch (err) {
      session.activity = 'error';
      session.errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, sessionId }, 'Failed to create agent session');
    }

    await this.eventBus.emit({
      type: 'session_updated',
      session: this.toPublicSession(session),
    });

    return session;
  }

  async sendSessionMessage(
    sessionId: string,
    text: string,
    participantChannel?: string,
    participantConversationId?: string
  ): Promise<Session> {
    return this.withSessionLock(sessionId, async () => {
      let session = this.managedSessions.get(sessionId) ?? this.sessions.findById(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      // Ensure participant
      if (participantChannel && participantConversationId) {
        this.participants.ensure({
          sessionId,
          channel: participantChannel,
          conversationId: participantConversationId,
          joinedAt: new Date().toISOString(),
        });
      }

      // Reopen if closed
      if (session.status === 'closed') {
        session.status = 'open';
        session.closedAt = null;
        session.errorMessage = null;
        this.sessions.updateStatus(sessionId, 'open');
      }

      session = await this.ensureAgentReady(session);

      // Store user message
      this.messages.insert(sessionId, 'user', text);
      this.sessions.touch(sessionId);

      logger.info(
        { sessionId, channel: participantChannel, textLength: text.length },
        'Sending user message to agent'
      );

      // Send to agent
      session.activity = 'running';
      session.outputPreview = '';

      await this.eventBus.emit({
        type: 'session_updated',
        session: this.toPublicSession(session),
      });

      let summary = '';
      try {
        const result = await this.agentService.sendPrompt(sessionId, text);
        summary = this.terminalText(result);

        if (result.status === 'error' || result.status === 'cancelled') {
          session.errorMessage = result.error ?? null;
          session.activity = 'error';
          logger.warn({ sessionId, error: result.error, status: result.status }, 'Agent run did not finish cleanly');
        } else {
          session.errorMessage = null;
        }

        if (summary) {
          this.messages.insert(sessionId, 'assistant', summary.slice(0, 20000));
          await this.deliverToParticipants(sessionId, summary);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        session.errorMessage = message;
        session.activity = 'error';
        logger.error({ err, sessionId }, 'sendSessionMessage failed');
        if (!summary) summary = `Agent error: ${message}`;
        try {
          await this.deliverToParticipants(sessionId, summary);
        } catch (deliverErr) {
          logger.error({ err: deliverErr, sessionId }, 'Failed to deliver agent error');
          throw err;
        }
      } finally {
        // `waiting_user` can be set from the question callback while this send is in flight.
        if (session.activity !== 'error') {
          session.activity = 'idle';
        }
      }

      this.sessions.touch(sessionId);
      await this.eventBus.emit({
        type: 'session_updated',
        session: this.toPublicSession(session),
      });

      return session;
    });
  }

  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    this.sessionLocks.set(sessionId, current);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === current) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  async submitIncoming(message: IncomingMessage): Promise<Session | null> {
    // Find or create session
    let session = this.sessions.findOpenByChannel(
      message.channel,
      message.conversationId,
      message.repoPath || ''
    );

    if (!session) {
      try {
        session = await this.createSession(
          message.channel,
          message.conversationId,
          message.repoPath || '',
          '',
          null
        );
      } catch (err) {
        if (err instanceof SessionLimitError) {
          return null;
        }
        throw err;
      }
    }

    await this.sendSessionMessage(
      session.id,
      message.text,
      message.channel,
      message.conversationId
    );

    return session;
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.managedSessions.get(sessionId) ?? this.sessions.findById(sessionId);
    if (!session) {
      return false;
    }

    // Close agent session
    await this.agentService.closeSession(sessionId);

    // Notify participants
    const participants = this.participants.listBySession(sessionId);
    for (const p of participants) {
      await this.eventBus.emit({
        type: 'channel_message',
        channel: p.channel,
        conversation_id: p.conversationId,
        text: 'Session closed. The agent process was stopped.',
      });
    }

    // Delete from DB
    this.messages.deleteBySession(sessionId);
    this.participants.deleteBySession(sessionId);
    this.sessions.delete(sessionId);
    this.managedSessions.delete(sessionId);

    await this.eventBus.emit({
      type: 'session_removed',
      session_id: sessionId,
    });

    return true;
  }

  async closeAllSessions(): Promise<number> {
    const sessions = this.sessions.listAll(true, 1000);

    // Close all agent sessions
    await this.agentService.closeAllSessions();

    // Delete all from DB
    for (const session of sessions) {
      this.messages.deleteBySession(session.id);
      this.participants.deleteBySession(session.id);
      this.sessions.delete(session.id);
    }

    this.managedSessions.clear();

    await this.eventBus.emit({
      type: 'sessions_purged',
    });

    return sessions.length;
  }

  async joinSession(sessionId: string, channel: string, conversationId: string): Promise<Session | null> {
    const session = this.sessions.findById(sessionId);
    if (!session) {
      return null;
    }

    this.participants.ensure({
      sessionId,
      channel,
      conversationId,
      joinedAt: new Date().toISOString(),
    });

    const ready = await this.ensureAgentReady(session);
    await this.eventBus.emit({
      type: 'session_updated',
      session: this.toPublicSession(ready),
    });

    return ready;
  }

  listSessions(channel: string, channelKey: string, includeClosed = false): Session[] {
    return this.sessions.listByChannel(channel, channelKey, includeClosed);
  }

  listAllSessions(includeClosed = false): Session[] {
    return this.sessions.listAll(includeClosed);
  }

  getSession(sessionId: string): Session | undefined {
    const managed = this.managedSessions.get(sessionId);
    if (managed) return managed;
    return this.sessions.findById(sessionId);
  }

  getSessionMessages(sessionId: string): ReturnType<MessageRepository['listBySession']> {
    return this.messages.listBySession(sessionId);
  }

  getDefaultModel(): string {
    return this.settings.get('default_model') || this.defaultModel;
  }

  setDefaultModel(model: string | null): void {
    if (model) {
      this.settings.set('default_model', model);
    } else {
      this.settings.delete('default_model');
    }
  }

  getAgentService(): AgentService {
    return this.agentService;
  }

  private toPublicSession(session: Session): Record<string, unknown> {
    return {
      id: session.id,
      channel: session.channel,
      channel_key: session.channelKey,
      repo_path: session.repoPath,
      repo_name: session.repoName,
      title: session.title,
      status: session.status,
      activity: session.activity,
      model: session.model,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      closed_at: session.closedAt,
      error_message: session.errorMessage,
      output_preview: session.outputPreview,
    };
  }
}
