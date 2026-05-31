/**
 * Dashboard Alpine.js application
 */

(function setupMarkdownSanitize() {
  if (typeof DOMPurify !== 'undefined') {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.hasAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }
})();

(function setupMarked() {
  if (typeof marked === 'undefined') return;

  // marked v5+ uses marked.use(); older builds use setOptions()
  const options = { gfm: true, breaks: true };
  if (typeof marked.use === 'function') {
    marked.use(options);
  } else if (typeof marked.setOptions === 'function') {
    marked.setOptions(options);
  }
})();

function dashboard() {
  return {
    // State
    webChannelKey: 'web:default',
    newRepoPath: '',
    newSessionModel: '',
    defaultModelPreference: '',
    maxSessions: 5,
    sessions: [],
    selectedSessionId: null,
    messages: [],
    draft: '',
    streamText: '',
    pendingQuestion: null,
    awaitingAgentReply: false,
    wsState: 'disconnected',
    availableModels: [],
    modelsLoadError: '',
    modelsLoading: false,
    workspaceRoot: '',
    repoPickerItems: [],
    selectedRepoPickId: '',
    repoPickerError: '',
    repoPickerLoading: false,
    repoCloneBusy: false,
    showNewSessionModal: false,
    sidebarCollapsed: false,

    // Computed
    get canSend() {
      return !!(this.selectedSessionId && this.draft.trim() && !this.awaitingAgentReply);
    },

    get selectedSession() {
      return this.sessions.find(s => s.id === this.selectedSessionId);
    },

    get atSessionLimit() {
      return this.sessions.length >= this.maxSessions;
    },

    // Methods
    async init() {
      try {
        const saved = localStorage.getItem('cp-sidebar-collapsed');
        if (saved === 'true') this.sidebarCollapsed = true;
        else if (saved === 'false') this.sidebarCollapsed = false;
        else if (window.matchMedia('(max-width: 767px)').matches) {
          this.sidebarCollapsed = true;
        }
      } catch {}

      await this.loadDashboardConfig();
      await this.loadRepoPicker();
      await this.refreshSessions();
      this.connectWebSocket();
      await this.fetchModels();
    },

    sessionWorkspacePath(session) {
      if (!session) return '—';
      const repoPath = session.repo_path != null ? String(session.repo_path).trim() : '';
      if (repoPath) return repoPath;
      const root = (this.workspaceRoot || '').trim();
      return root || 'Workspace root';
    },

    mergeSession(session) {
      if (!session?.id) return;
      const idx = this.sessions.findIndex(s => s.id === session.id);
      if (idx >= 0) {
        this.sessions[idx] = session;
      } else {
        this.sessions.unshift(session);
      }
    },

    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      try {
        localStorage.setItem('cp-sidebar-collapsed', this.sidebarCollapsed ? 'true' : 'false');
      } catch {}
    },

    collapseSidebarIfMobile() {
      if (!window.matchMedia('(max-width: 767px)').matches) return;
      this.sidebarCollapsed = true;
      try {
        localStorage.setItem('cp-sidebar-collapsed', 'true');
      } catch {}
    },

    async loadDashboardConfig() {
      try {
        const r = await fetch('/api/dashboard-config');
        if (r.ok) {
          const d = await r.json();
          this.webChannelKey = d.web_channel_key || 'web:default';
          this.workspaceRoot = d.workspace_root || '';
          this.defaultModelPreference = d.default_model || '';
          this.maxSessions = d.max_sessions || this.maxSessions;
        }
      } catch (err) {
        console.error('Failed to load dashboard config:', err);
      }
    },

    async fetchModels() {
      this.modelsLoading = true;
      try {
        const r = await fetch('/api/models');
        const d = await r.json();
        this.availableModels = d.models || [];
        this.modelsLoadError = d.error || '';
      } catch (err) {
        this.modelsLoadError = 'Failed to load models';
      } finally {
        this.modelsLoading = false;
      }
    },

    async saveDefaultModel() {
      try {
        await fetch('/api/settings/default-model', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.defaultModelPreference }),
        });
      } catch (err) {
        console.error('Failed to save default model:', err);
      }
    },

    async loadRepoPicker() {
      this.repoPickerLoading = true;
      this.repoPickerError = '';
      try {
        const r = await fetch('/api/repo-picker?gh_limit=80');
        const d = await r.json();
        this.repoPickerItems = d.items || [];
        this.repoPickerError = d.error || '';
      } catch (err) {
        this.repoPickerError = 'Failed to load repositories';
      } finally {
        this.repoPickerLoading = false;
      }
    },

    isCloned(item) {
      return this.repoPickerItems.some(i => i.nameWithOwner === item.nameWithOwner && i.type === 'local');
    },

    async createSession() {
      if (!this.selectedRepoPickId) return;

      let repoPath = this.selectedRepoPickId;

      // Handle GitHub clone
      if (repoPath.includes('/')) {
        this.repoCloneBusy = true;
        try {
          const r = await fetch('/api/github/clone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nameWithOwner: repoPath }),
          });
          const d = await r.json();
          if (d.error) {
            alert(d.error);
            return;
          }
          repoPath = d.path;
        } finally {
          this.repoCloneBusy = false;
        }
      }

      try {
        const r = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repoPath,
            model: this.newSessionModel || null,
          }),
        });

        if (!r.ok) {
          const d = await r.json();
          alert(d.error || 'Failed to create session');
          return;
        }

        const session = await r.json();
        this.sessions.unshift(session);
        this.selectSession(session.id);
        this.showNewSessionModal = false;
        this.selectedRepoPickId = '';
        this.newSessionModel = '';
      } catch (err) {
        console.error('Failed to create session:', err);
      }
    },

    async refreshSessions() {
      try {
        const r = await fetch('/api/sessions?include_closed=false');
        this.sessions = await r.json();
      } catch (err) {
        console.error('Failed to refresh sessions:', err);
      }
    },

    async loadMessages(sessionId = this.selectedSessionId) {
      if (!sessionId) return;

      try {
        const r = await fetch(`/api/sessions/${sessionId}/messages`);
        if (r.ok) {
          this.messages = await r.json();
          this.scrollToBottom();
        }
      } catch (err) {
        console.error('Failed to load messages:', err);
      }
    },

    async selectSession(id) {
      this.selectedSessionId = id;
      this.messages = [];
      this.streamText = '';
      this.pendingQuestion = null;

      // Collapse sidebar on mobile after selecting a session
      this.collapseSidebarIfMobile();

      await this.loadMessages(id);
    },

    async sendMessage() {
      if (!this.canSend) return;

      const text = this.draft.trim();
      this.draft = '';
      this.awaitingAgentReply = true;
      this.streamText = '';

      // Add user message to UI immediately
      this.messages.push({ role: 'user', content: text });
      this.scrollToBottom();

      try {
        const r = await fetch(`/api/sessions/${this.selectedSessionId}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });

        if (!r.ok) {
          const d = await r.json();
          alert(d.error || 'Failed to send message');
          this.awaitingAgentReply = false;
          return;
        }

        const session = await r.json();
        this.updateSession(session);
        this.awaitingAgentReply = false;
        this.streamText = '';
        await this.loadMessages();
      } catch (err) {
        console.error('Failed to send message:', err);
        this.awaitingAgentReply = false;
      }
    },

    async closeSession(id) {
      try {
        await fetch(`/api/sessions/${id}/close`, { method: 'POST' });
        this.sessions = this.sessions.filter(s => s.id !== id);
        if (this.selectedSessionId === id) {
          this.selectedSessionId = null;
          this.messages = [];
        }
      } catch (err) {
        console.error('Failed to close session:', err);
      }
    },

    async closeAllSessions() {
      if (!this.sessions.length) return;

      try {
        await fetch('/api/sessions/close-all', { method: 'POST' });
        this.sessions = [];
        this.selectedSessionId = null;
        this.messages = [];
        this.streamText = '';
        this.pendingQuestion = null;
      } catch (err) {
        console.error('Failed to close all sessions:', err);
      }
    },

    async answerQuestion(answer) {
      if (!this.pendingQuestion) return;

      this.pendingQuestion = null;

      try {
        await fetch(`/api/sessions/${this.selectedSessionId}/answer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer }),
        });
      } catch (err) {
        console.error('Failed to answer question:', err);
      }
    },

    updateSession(session) {
      this.mergeSession(session);
    },

    scrollToBottom() {
      this.$nextTick(() => {
        const container = this.$refs.messagesContainer;
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
      });
    },

    renderMarkdown(text) {
      if (!text) return '';
      if (typeof marked === 'undefined') {
        return this.escapeHtml(text).replace(/\n/g, '<br>');
      }

      try {
        const raw = typeof marked.parse === 'function'
          ? marked.parse(text, { async: false })
          : marked(text);
        return DOMPurify.sanitize(raw, {
          USE_PROFILES: { html: true },
        });
      } catch {
        return this.escapeHtml(text).replace(/\n/g, '<br>');
      }
    },

    escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },

    connectWebSocket() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`);

      ws.onopen = () => {
        this.wsState = 'connected';
        console.log('WebSocket connected');
      };

      ws.onclose = () => {
        this.wsState = 'disconnected';
        console.log('WebSocket disconnected, reconnecting...');
        setTimeout(() => this.connectWebSocket(), 3000);
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleWebSocketMessage(data);
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };
    },

    handleWebSocketMessage(data) {
      switch (data.type) {
        case 'hello':
          console.log('Server hello received');
          break;

        case 'session_updated':
          this.updateSession(data.session);
          if (data.session?.id === this.selectedSessionId && data.session?.activity === 'idle') {
            this.awaitingAgentReply = false;
            this.streamText = '';
            this.loadMessages(data.session.id);
          }
          break;

        case 'session_removed':
          this.sessions = this.sessions.filter(s => s.id !== data.session_id);
          if (this.selectedSessionId === data.session_id) {
            this.selectedSessionId = null;
            this.messages = [];
          }
          break;

        case 'sessions_purged':
          this.sessions = [];
          this.selectedSessionId = null;
          this.messages = [];
          break;

        case 'agent_stream':
          if (data.session_id === this.selectedSessionId) {
            this.streamText += data.text;
            this.scrollToBottom();
          }
          break;

        case 'channel_message':
          if (data.channel === 'web' && data.conversation_id === this.webChannelKey) {
            // System message, could show as toast
            console.log('Channel message:', data.text);
          }
          break;

        case 'question':
          if (data.session_id === this.selectedSessionId) {
            this.pendingQuestion = {
              question: data.question,
              options: data.options,
            };
            this.awaitingAgentReply = false;
            this.scrollToBottom();
          }
          break;

        case 'pong':
          // Keep alive
          break;
      }
    },
  };
}

// Expose for Alpine
window.dashboard = dashboard;
