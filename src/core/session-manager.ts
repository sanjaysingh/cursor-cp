/**
 * Session Manager
 * Orchestrates sessions, database, and agent service
 */

import { randomUUID } from 'crypto';
import { basename } from 'path';
import type { Session, IncomingMessage } from '../models/types.js';
import type { SessionRepository, MessageRepository, ParticipantRepository, SettingsRepository } from '../db/repositories.js';
import { AgentService } from './agent-service.js';
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

    // Only stream assistant text to clients — skip tool/thinking/status noise
    this.agentService.onStream((sessionId, chunk) => {
      if (chunk.type === 'text') {
        this.handleStreamChunk(sessionId, chunk.text);
      }
    });

    // Set up question handler - CRITICAL FIX: Pass full question context
    this.agentService.onQuestion(async (sessionId, question) => {
      return this.handleAgentQuestion(sessionId, question);
    });
  }

  /**
   * Handle agent questions with full context - THIS IS THE BUG FIX
   * Ensures users see the full question text, not just an "OK" button
   */
  private async handleAgentQuestion(
    sessionId: string,
    question: { question: string; options: string[] }
  ): Promise<string> {
    const session = this.managedSessions.get(sessionId);
    if (!session) {
      // No session found, return first option as default
      return question.options[0] || 'OK';
    }

    // Store in session that we're waiting for user input
    session.activity = 'waiting_user';
    await this.eventBus.emit({
      type: 'session_updated',
      session: this.toPublicSession(session),
    });

    // Get all participants for this session
    const participants = await this.participants.listBySession(sessionId);

    // Ask question on all channels with FULL CONTEXT
    // This is the fix - we pass the complete question text, not just "OK"
    const answerPromises: Promise<string>[] = [];

    for (const participant of participants) {
      const channel = this.registry.get(participant.channel);
      if (!channel) continue;

      // Create proper question text with context
      const fullQuestionText = question.question;

      // Ask the question - this will show the full question text to users
      const answerPromise = channel.askQuestion(
        participant.conversationId,
        fullQuestionText,
        question.options,
        { sessionId, conversationId: participant.conversationId }
      );

      answerPromises.push(answerPromise);
    }

    // Wait for first answer (first-answer-wins strategy)
    if (answerPromises.length > 0) {
      try {
        const answers = await Promise.allSettled(answerPromises);

        // Find first successful answer
        for (const result of answers) {
          if (result.status === 'fulfilled' && result.value) {
            // Broadcast the answer to all participants
            for (const participant of participants) {
              const channel = this.registry.get(participant.channel);
              if (channel) {
                await channel.sendMessage(
                  participant.conversationId,
                  `✅ Answered: ${result.value}`
                );
              }
            }

            // Update session back to running
            session.activity = 'running';
            await this.eventBus.emit({
              type: 'session_updated',
              session: this.toPublicSession(session),
            });

            return result.value;
          }
        }
      } catch (err) {
        logger.error({ err, sessionId }, 'Error handling agent question');
      }
    }

    // Fallback: return first option
    session.activity = 'running';
    return question.options[0] || 'OK';
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

  /**
   * Send assistant output to non-web participants (Telegram, etc.).
   * Web clients receive real-time chunks via agent_stream on the event bus.
   */
  private async deliverToParticipants(sessionId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const participants = this.participants.listBySession(sessionId);
    for (const participant of participants) {
      if (participant.channel === 'web') continue;

      const channel = this.registry.get(participant.channel);
      if (!channel) {
        logger.warn(
          { sessionId, channel: participant.channel },
          'No channel registered for participant delivery'
        );
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
      }
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

    try {
      const result = await this.agentService.sendPrompt(sessionId, text);

      if (result.success) {
        const streamed = session.outputPreview.trim();
        const resultText = result.text.trim();
        const summary = streamed || resultText;

        if (summary) {
          this.messages.insert(sessionId, 'assistant', summary.slice(0, 20000));
        }
        session.errorMessage = null;

        // Non-web channels do not receive agent_stream — deliver the full reply here.
        if (summary) {
          await this.deliverToParticipants(sessionId, summary);
        }
      } else {
        session.errorMessage = result.error ?? null;
        session.activity = 'error';
        logger.warn({ sessionId, error: result.error }, 'Agent returned error');
        if (result.error) {
          await this.deliverToParticipants(sessionId, `Agent error: ${result.error}`);
        }
      }
    } catch (err) {
      session.errorMessage = err instanceof Error ? err.message : String(err);
      session.activity = 'error';
      logger.error({ err, sessionId }, 'sendSessionMessage failed');
      await this.deliverToParticipants(
        sessionId,
        `Agent error: ${session.errorMessage}`
      );
    } finally {
      if (session.activity === 'running') {
        session.activity = 'idle';
      }
    }

    this.sessions.touch(sessionId);
    await this.eventBus.emit({
      type: 'session_updated',
      session: this.toPublicSession(session),
    });

    return session;
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
