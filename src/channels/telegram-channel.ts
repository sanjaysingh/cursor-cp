/**
 * Telegram Bot Channel using Telegraf
 */

import { Telegraf, Markup, Context } from 'telegraf';
import type { Update } from 'telegraf/types';
import type { Channel } from './base.js';
import type { MessageTarget, AppConfig } from '../models/types.js';
import type { SessionManager } from '../core/session-manager.js';
import { listLocalWorkspaceItems } from '../core/repo-picker.js';
import { splitPlainText, markdownToTelegram, markdownToTelegramHtml } from '../format/telegram-format.js';
import { createHash } from 'crypto';
import { logger } from '../util/logger.js';
import { getVersion } from '../cli/help.js';

interface PendingQuestion {
  resolve: (answer: string) => void;
  options: string[];
  sessionId: string;
}

export class TelegramChannel implements Channel {
  readonly name = 'telegram';

  private bot: Telegraf<Context<Update>>;
  private sessionManager: SessionManager;
  private allowedUserIds: Set<number>;
  private config: AppConfig;

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
    config: AppConfig
  ) {
    this.bot = new Telegraf(token);
    this.sessionManager = sessionManager;
    this.allowedUserIds = allowedUserIds;
    this.config = config;

    this.setupHandlers();
    this.setupMiddleware();
  }

  private setupMiddleware(): void {
    // Allowlist middleware
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.allowedUserIds.has(userId)) {
        logger.warn(
          { userId, username: ctx.from?.username, updateType: ctx.updateType },
          'Telegram access denied'
        );
        return;
      }
      return next();
    });
  }

  private botCommands(): Array<{ command: string; description: string }> {
    return [
      { command: 'start', description: 'Show help' },
      { command: 'sessions', description: 'List sessions and connect' },
      { command: 'models', description: 'List models and set default' },
      { command: 'current', description: 'Show current session' },
      { command: 'close', description: 'Close current session' },
      { command: 'closeall', description: 'Close all sessions' },
      { command: 'repos', description: 'GitHub repos (gh)' },
      { command: 'workspaces', description: 'Local workspace folders' },
      { command: 'version', description: 'Show Cursor Control Plane version' },
    ];
  }

  /** Register slash commands for allowed users (Telegram autocomplete menu). */
  private async syncBotCommands(): Promise<void> {
    try {
      await this.bot.telegram.deleteMyCommands();
    } catch (err) {
      logger.warn({ err }, 'Could not clear default Telegram command list');
    }

    if (this.allowedUserIds.size === 0) {
      logger.warn(
        'Telegram is enabled but TELEGRAM_ALLOWED_USER_IDS is empty — slash commands will not appear'
      );
      return;
    }

    for (const userId of this.allowedUserIds) {
      await this.syncBotCommandsForUser(userId);
    }
  }

  private async syncBotCommandsForUser(userId: number): Promise<void> {
    try {
      await this.bot.telegram.setMyCommands(this.botCommands(), {
        scope: { type: 'chat', chat_id: userId },
      });
      logger.info({ userId }, 'Telegram slash commands registered');
    } catch (err) {
      logger.warn(
        { err, userId },
        'Could not set Telegram commands for user (send /start to the bot first)'
      );
    }
  }

  private setupHandlers(): void {
    // Start command
    this.bot.command('start', async (ctx) => {
      const userId = ctx.from?.id;
      if (userId) {
        await this.syncBotCommandsForUser(userId);
      }

      await ctx.reply(
        '🤖 *Cursor Control Plane*\n\n' +
        'Available commands:\n' +
        '/sessions - List and connect to sessions\n' +
        '/models - List models and set default\n' +
        '/repos - Browse GitHub repositories\n' +
        '/workspaces - Browse local workspaces\n' +
        '/current - Show current session\n' +
        '/close - Close current session\n' +
        '/closeall - Close all sessions\n' +
        '/version - Show version\n\n' +
        'Send me any text to start or continue a session.',
        { parse_mode: 'Markdown' }
      );
    });

    // Version
    this.bot.command('version', async (ctx) => {
      await ctx.reply(`Cursor Control Plane v${getVersion()}`);
    });

    // Sessions list
    this.bot.command('sessions', async (ctx) => {
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
      const models = await this.sessionManager.getAgentService().listAvailableModels();

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
      } catch {
        await ctx.reply('Could not list GitHub repos. Is `gh` installed and logged in?');
      }
    });

    // Workspaces (same local folders as the web repo picker)
    this.bot.command('workspaces', async (ctx) => {
      const chatId = String(ctx.chat?.id);

      try {
        const items = await listLocalWorkspaceItems(this.config);

        if (items.length === 0) {
          await ctx.reply(
            `No workspace folders yet under:\n${this.config.workspaceRoot}\n\n` +
            'Clone a repo with /repos or add folders there.'
          );
          return;
        }

        const paths = items.map((item) => item.path);
        this.pendingWorkspaces.set(chatId, paths);

        const buttons = items.map((item, i) => {
          const name = item.path.split(/[/\\]/).pop() || item.label.replace(/^local-/, '');
          const label = name.slice(0, 60);
          return [Markup.button.callback(label, `ws:${i}`)];
        });

        await ctx.reply(
          `Local workspaces under ${this.config.workspaceRoot} — tap to use:`,
          Markup.inlineKeyboard(buttons)
        );
      } catch (err) {
        logger.error({ err, workspaceRoot: this.config.workspaceRoot }, 'Failed to list workspaces');
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
      const _chatId = String(ctx.chat?.id);
      const models = this.modelIds.get(_chatId);

      if (models) {
        const model = models[index];
        if (model) {
          this.sessionManager.setDefaultModel(model);
          await ctx.answerCbQuery(`Default model set to ${model}`);
          await ctx.reply(`✅ Default model set to: ${model}`);
        }
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

        const workspaceRoot = this.config.workspaceRoot;
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
      const paths = this.pendingWorkspaces.get(chatId);

      if (!paths || !paths[index]) {
        await ctx.answerCbQuery('Invalid selection');
        return;
      }

      const path = paths[index];
      const name = path.split(/[/\\]/).pop() || 'workspace';

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

      logger.info({ chatId, textLength: text.length }, 'Telegram text message received');

      try {
        // Check if we have an active session
        let sessionId = this.activeSessions.get(chatId);

        if (!sessionId) {
          // Try to find an existing open session
          const sessions = this.sessionManager.listAllSessions(false);
          const existing = sessions.find((s) => s.channel === 'telegram' && s.channelKey === chatId);

          if (existing) {
            sessionId = existing.id;
            this.activeSessions.set(chatId, sessionId);
            logger.info({ chatId, sessionId }, 'Reconnected to existing Telegram session');
          } else {
            // Create new session without a specific repo
            const session = await this.sessionManager.createSession('telegram', chatId, '', 'Telegram Session');
            sessionId = session.id;
            this.activeSessions.set(chatId, sessionId);
            logger.info({ chatId, sessionId }, 'Created new Telegram session');
            await ctx.reply('✅ Created new session. Processing your message…');
          }
        }

        await ctx.sendChatAction('typing');
        await this.sessionManager.sendSessionMessage(sessionId, text, 'telegram', chatId);
        logger.info({ chatId, sessionId }, 'Telegram message dispatched to agent');
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to handle Telegram text message');
        await ctx.reply(
          `❌ Error: ${err instanceof Error ? err.message : String(err)}`
        ).catch((replyErr) => {
          logger.error({ err: replyErr, chatId }, 'Failed to send Telegram error reply');
        });
      }
    });
  }

  async start(): Promise<void> {
    await this.bot.launch();
    await this.syncBotCommands();
    logger.info('Telegram bot polling started');
  }

  async stop(): Promise<void> {
    this.bot.stop();
    logger.info('Telegram bot stopped');
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    if (!text) return;

    logger.debug({ conversationId, textLength: text.length }, 'Sending Telegram message');

    if (text.length <= 4096) {
      await this.sendMarkdownMessage(conversationId, text);
      return;
    }

    for (const chunk of splitPlainText(text, 4096)) {
      await this.sendMarkdownMessage(conversationId, chunk);
    }
  }

  /** Send markdown with HTML formatting (matches web bold/italic); plain text on failure. */
  private async sendMarkdownMessage(conversationId: string, markdown: string): Promise<void> {
    const html = markdownToTelegramHtml(markdown);
    if (html) {
      try {
        await this.bot.telegram.sendMessage(conversationId, html, { parse_mode: 'HTML' });
        return;
      } catch (err) {
        logger.warn({ err, conversationId }, 'Telegram rejected HTML message, sending plain');
      }
    }

    const plain = markdownToTelegram(markdown);
    try {
      await this.bot.telegram.sendMessage(conversationId, plain.text.slice(0, 4096));
    } catch (err) {
      logger.error({ err, conversationId }, 'Failed to send Telegram message chunk');
      throw err;
    }
  }

  private async sendFormattedWithKeyboard(
    conversationId: string,
    text: string,
    keyboard: ReturnType<typeof Markup.inlineKeyboard>
  ): Promise<void> {
    const html = markdownToTelegramHtml(text);
    if (html) {
      try {
        await this.bot.telegram.sendMessage(conversationId, html, {
          parse_mode: 'HTML',
          ...keyboard,
        });
        return;
      } catch (err) {
        logger.warn({ err, conversationId }, 'Telegram rejected formatted question, sending plain');
      }
    }

    const plain = markdownToTelegram(text);
    await this.bot.telegram.sendMessage(
      conversationId,
      plain.text.slice(0, 4096),
      keyboard
    );
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

    await this.sendFormattedWithKeyboard(
      conversationId,
      question,
      Markup.inlineKeyboard(buttons)
    );

    return new Promise((resolve) => {
      this.pendingQuestions.set(token, {
        resolve,
        options,
        sessionId: target.sessionId,
      });

      // Set up one-time handler for this question
      this.bot.action(new RegExp(`q:${token}:(\\d+)`), async (ctx) => {
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
