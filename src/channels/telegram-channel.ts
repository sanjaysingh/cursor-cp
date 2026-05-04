/**
 * Telegram Bot Channel using Telegraf
 */

import { Telegraf, Markup, Context } from 'telegraf';
import type { Update } from 'telegraf/types';
import type { Channel } from './base.js';
import type { MessageTarget, IncomingMessage } from '../models/types.js';
import { EventBus } from '../core/events.js';
import type { SessionManager } from '../core/session-manager.js';
import { markdownToTelegram, splitForTelegram } from '../format/telegram-format.js';
import { createHash } from 'crypto';

interface PendingQuestion {
  resolve: (answer: string) => void;
  options: string[];
  sessionId: string;
}

interface SessionInfo {
  id: string;
  title: string;
  repoName: string;
  status: string;
  activity: string;
  model: string | null;
}

export class TelegramChannel implements Channel {
  readonly name = 'telegram';

  private bot: Telegraf<Context<Update>>;
  private sessionManager: SessionManager;
  private allowedUserIds: Set<number>;
  private eventBus: EventBus;

  // Pending questions by callback token
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  // GitHub repo selection pending
  private pendingGitHubRepos: Map<string, string[]> = new Map();
  // Workspace selection pending
  private pendingWorkspaces: Map<string, string[]> = new Map();
  // Model IDs for callbacks
  private modelIds: Map<string, string[]> = new Map();

  // Track active sessions per chat
  private activeSessions: Map<string, string> = new Map();

  constructor(
    token: string,
    sessionManager: SessionManager,
    allowedUserIds: Set<number>,
    eventBus: EventBus
  ) {
    this.bot = new Telegraf(token);
    this.sessionManager = sessionManager;
    this.allowedUserIds = allowedUserIds;
    this.eventBus = eventBus;

    this.setupHandlers();
    this.setupMiddleware();
  }

  private setupMiddleware(): void {
    // Allowlist middleware
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.allowedUserIds.has(userId)) {
        console.warn(`Telegram access denied for user ${userId}`);
        return;
      }
      return next();
    });
  }

  private setupHandlers(): void {
    // Start command
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        '🤖 *Cursor Control Plane*\n\n' +
        'Available commands:\n' +
        '/sessions - List and connect to sessions\n' +
        '/models - List models and set default\n' +
        '/repos - Browse GitHub repositories\n' +
        '/workspaces - Browse local workspaces\n' +
        '/current - Show current session\n' +
        '/close - Close current session\n' +
        '/closeall - Close all sessions\n\n' +
        'Send me any text to start or continue a session.',
        { parse_mode: 'Markdown' }
      );
    });

    // Sessions list
    this.bot.command('sessions', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const sessions = this.sessionManager.listAllSessions(false);

      if (sessions.length === 0) {
        await ctx.reply('No active sessions. Send me text to create one!');
        return;
      }

      const buttons = sessions.map((s) => {
        const status = s.status === 'open' ? '🟢' : '⚫';
        const model = s.model ? ` [${s.model}]` : '';
        const label = `${status} ${s.title || s.repoName}${model}`.slice(0, 60);
        return [Markup.button.callback(label, `session:${s.id}`)];
      });

      await ctx.reply('Active sessions — tap to connect:', Markup.inlineKeyboard(buttons));
    });

    // Models list
    this.bot.command('models', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const models = await this.sessionManager.agentService.listAvailableModels();

      if (models.length === 0) {
        await ctx.reply('No models available.');
        return;
      }

      const buttons = models.map((m, i) => {
        return [Markup.button.callback(m.name, `model:${i}`)];
      });

      this.modelIds.set(
        chatId,
        models.map((m) => m.id)
      );

      await ctx.reply(
        'Available models — tap to set as default:\n' +
        `(Current: ${this.sessionManager.getDefaultModel() || 'Auto'})`,
        Markup.inlineKeyboard(buttons)
      );
    });

    // Current session
    this.bot.command('current', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const sessionId = this.activeSessions.get(chatId);

      if (!sessionId) {
        await ctx.reply('No active session. Use /sessions to connect to one.');
        return;
      }

      const session = this.sessionManager.getSession(sessionId);
      if (!session) {
        await ctx.reply('Session not found. It may have been closed.');
        return;
      }

      await ctx.reply(
        `📁 *${session.title || session.repoName}*\n` +
        `Status: ${session.status}\n` +
        `Activity: ${session.activity}\n` +
        `Model: ${session.model || 'Auto'}`,
        { parse_mode: 'Markdown' }
      );
    });

    // Close current session
    this.bot.command('close', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const sessionId = this.activeSessions.get(chatId);

      if (!sessionId) {
        await ctx.reply('No active session to close.');
        return;
      }

      await this.sessionManager.closeSession(sessionId);
      this.activeSessions.delete(chatId);
      await ctx.reply('✅ Session closed.');
    });

    // Close all sessions
    this.bot.command('closeall', async (ctx) => {
      const count = await this.sessionManager.closeAllSessions();
      this.activeSessions.clear();
      await ctx.reply(`✅ Closed ${count} session(s).`);
    });

    // GitHub repos
    this.bot.command('repos', async (ctx) => {
      const chatId = String(ctx.chat?.id);

      try {
        const { execa } = await import('execa');
        const { stdout } = await execa('gh', ['repo', 'list', '--limit', '20', '--json', 'nameWithOwner']);
        const repos = JSON.parse(stdout) as Array<{ nameWithOwner: string }>;

        if (repos.length === 0) {
          await ctx.reply('No GitHub repos found. Make sure `gh` is installed and authenticated.');
          return;
        }

        const owners = repos.map((r) => r.nameWithOwner);
        this.pendingGitHubRepos.set(chatId, owners);

        const buttons = owners.map((nwo, i) => {
          return [Markup.button.callback(nwo, `gh:${i}`)];
        });

        await ctx.reply('GitHub repos — tap to clone:', Markup.inlineKeyboard(buttons));
      } catch (err) {
        await ctx.reply('Could not list GitHub repos. Is `gh` installed and logged in?');
      }
    });

    // Workspaces
    this.bot.command('workspaces', async (ctx) => {
      const chatId = String(ctx.chat?.id);

      try {
        const { readdir } = await import('fs/promises');
        const workspaceRoot = process.env.WORKSPACE_ROOT || '';
        const entries = await readdir(workspaceRoot, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);

        if (dirs.length === 0) {
          await ctx.reply('No workspaces found.');
          return;
        }

        this.pendingWorkspaces.set(chatId, dirs);

        const buttons = dirs.map((name, i) => {
          return [Markup.button.callback(name, `ws:${i}`)];
        });

        await ctx.reply('Local workspaces — tap to use:', Markup.inlineKeyboard(buttons));
      } catch {
        await ctx.reply('Could not list workspaces.');
      }
    });

    // Handle session selection callback
    this.bot.action(/session:(.+)/, async (ctx) => {
      const sessionId = ctx.match[1];
      const chatId = String(ctx.chat?.id);

      await this.sessionManager.joinSession(sessionId, 'telegram', chatId);
      this.activeSessions.set(chatId, sessionId);

      await ctx.answerCbQuery('Connected to session');
      await ctx.reply('✅ Connected to session. You can now send messages.');
    });

    // Handle model selection callback
    this.bot.action(/model:(\d+)/, async (ctx) => {
      const index = parseInt(ctx.match[1], 10);
      const chatId = String(ctx.chat?.id);
      const models = this.modelIds.get(chatId);

      if (models && models[index]) {
        this.sessionManager.setDefaultModel(models[index]);
        await ctx.answerCbQuery(`Default model set to ${models[index]}`);
        await ctx.reply(`✅ Default model set to: ${models[index]}`);
      }
    });

    // Handle GitHub repo selection
    this.bot.action(/gh:(\d+)/, async (ctx) => {
      const index = parseInt(ctx.match[1], 10);
      const chatId = String(ctx.chat?.id);
      const repos = this.pendingGitHubRepos.get(chatId);

      if (!repos || !repos[index]) {
        await ctx.answerCbQuery('Invalid selection');
        return;
      }

      const nwo = repos[index];
      await ctx.answerCbQuery(`Cloning ${nwo}...`);

      try {
        const { execa } = await import('execa');
        const { mkdir } = await import('fs/promises');
        const { resolve } = await import('path');

        const workspaceRoot = process.env.WORKSPACE_ROOT || '';
        await mkdir(workspaceRoot, { recursive: true });

        const repoName = nwo.split('/')[1];
        const targetPath = resolve(workspaceRoot, repoName);

        // Check if already exists
        const { existsSync } = await import('fs');
        if (existsSync(targetPath)) {
          await ctx.reply(`📁 ${repoName} already exists. Using existing.`);
        } else {
          await execa('gh', ['repo', 'clone', nwo], { cwd: workspaceRoot });
          await ctx.reply(`✅ Cloned ${nwo}`);
        }

        // Create session with this repo
        const session = await this.sessionManager.createSession('telegram', chatId, targetPath, repoName);
        this.activeSessions.set(chatId, session.id);
        await ctx.reply(`✅ Created session for ${repoName}. Send me text to start!`);
      } catch (err) {
        await ctx.reply(`❌ Failed to clone: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // Handle workspace selection
    this.bot.action(/ws:(\d+)/, async (ctx) => {
      const index = parseInt(ctx.match[1], 10);
      const chatId = String(ctx.chat?.id);
      const workspaces = this.pendingWorkspaces.get(chatId);

      if (!workspaces || !workspaces[index]) {
        await ctx.answerCbQuery('Invalid selection');
        return;
      }

      const name = workspaces[index];
      const { resolve } = await import('path');
      const workspaceRoot = process.env.WORKSPACE_ROOT || '';
      const path = resolve(workspaceRoot, name);

      await ctx.answerCbQuery(`Using workspace: ${name}`);

      const session = await this.sessionManager.createSession('telegram', chatId, path, name);
      this.activeSessions.set(chatId, session.id);
      await ctx.reply(`✅ Created session for ${name}. Send me text to start!`);
    });

    // Handle text messages
    this.bot.on('text', async (ctx) => {
      const chatId = String(ctx.chat?.id);
      const text = ctx.message.text;

      // Ignore commands
      if (text.startsWith('/')) return;

      // Check if we have an active session
      let sessionId = this.activeSessions.get(chatId);

      if (!sessionId) {
        // Try to find an existing open session
        const sessions = this.sessionManager.listAllSessions(false);
        const existing = sessions.find((s) => s.channel === 'telegram' && s.channelKey === chatId);

        if (existing) {
          sessionId = existing.id;
          this.activeSessions.set(chatId, sessionId);
        } else {
          // Create new session without a specific repo
          const session = await this.sessionManager.createSession('telegram', chatId, '', 'Telegram Session');
          sessionId = session.id;
          this.activeSessions.set(chatId, sessionId);
          await ctx.reply('✅ Created new session. Send me code or questions!');
        }
      }

      // Send message to session
      await this.sessionManager.sendSessionMessage(sessionId, text, 'telegram', chatId);

      // The response will come through the event bus and be handled by onStream
    });
  }

  async start(): Promise<void> {
    // Launch bot
    await this.bot.launch();

    // Set up event bus listener for streaming responses
    this.eventBus.on('agent_stream', (event) => {
      const { sessionId, text } = event as { type: 'agent_stream'; sessionId: string; text: string };

      // Find which chat has this session
      for (const [chatId, sid] of this.activeSessions) {
        if (sid === sessionId) {
          // Send streaming text
          this.bot.telegram.sendMessage(chatId, text).catch((err) => {
            console.error('Failed to send Telegram message:', err);
          });
          break;
        }
      }
    });

    console.log('Telegram bot started');
  }

  async stop(): Promise<void> {
    this.bot.stop();
    console.log('Telegram bot stopped');
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    // Split long messages and format with markdown
    const chunks = splitForTelegram(text, 4096);

    for (const chunk of chunks) {
      if (chunk.entities && chunk.entities.length > 0) {
        // Send with entities for rich formatting
        await this.bot.telegram.sendMessage(conversationId, chunk.text, {
          entities: chunk.entities.map((e) => ({
            type: e.type,
            offset: e.offset,
            length: e.length,
            url: e.url,
            language: e.language,
          })),
        });
      } else {
        // Plain text - escape markdown characters
        const escaped = chunk.text.replace(/[_*[`]/g, '\\$&');
        await this.bot.telegram.sendMessage(conversationId, escaped, { parse_mode: 'MarkdownV2' });
      }
    }
  }

  async askQuestion(
    conversationId: string,
    question: string,
    options: string[],
    target: MessageTarget
  ): Promise<string> {
    const token = this.createQuestionToken(target.sessionId, conversationId);

    const buttons = options.map((opt, i) => {
      return [Markup.button.callback(opt, `q:${token}:${i}`)];
    });

    await this.bot.telegram.sendMessage(conversationId, question, Markup.inlineKeyboard(buttons));

    return new Promise((resolve) => {
      this.pendingQuestions.set(token, {
        resolve,
        options,
        sessionId: target.sessionId,
      });

      // Set up one-time handler for this question
      const handler = this.bot.action(new RegExp(`q:${token}:(\\d+)`), async (ctx) => {
        const index = parseInt(ctx.match[1], 10);
        const pending = this.pendingQuestions.get(token);

        if (pending) {
          pending.resolve(pending.options[index] || '');
          this.pendingQuestions.delete(token);
          await ctx.answerCbQuery();
          await ctx.reply(`✅ Selected: ${pending.options[index]}`);
        }
      });

      // Timeout after 1 hour
      setTimeout(() => {
        const pending = this.pendingQuestions.get(token);
        if (pending) {
          pending.resolve(pending.options[0] || '');
          this.pendingQuestions.delete(token);
        }
      }, 3600000);
    });
  }

  private createQuestionToken(sessionId: string, conversationId: string): string {
    return createHash('sha256')
      .update(`${sessionId}:${conversationId}`)
      .digest('hex')
      .slice(0, 12);
  }
}
