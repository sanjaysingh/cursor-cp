/**
 * Core domain types for Cursor Control Plane
 */

export type SessionStatus = 'open' | 'closed';
export type AgentActivity = 'idle' | 'connecting' | 'running' | 'waiting_user' | 'error';

export interface Session {
  id: string;
  channel: string;
  channelKey: string;
  repoPath: string;
  repoName: string;
  title: string;
  status: SessionStatus;
  activity: AgentActivity;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  errorMessage: string | null;
  outputPreview: string;
}

export interface SessionMessage {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
}

export interface SessionParticipant {
  sessionId: string;
  channel: string;
  conversationId: string;
  joinedAt: string;
}

export interface MessageTarget {
  sessionId: string;
  conversationId: string;
}

export interface IncomingMessage {
  conversationId: string;
  channel: string;
  text: string;
  repoPath?: string;
}

export interface RepoEntry {
  name: string;
  path: string;
  description: string;
}

export interface ChannelConfig {
  enabled: boolean;
}

export interface ServerConfig {
  host: string;
  port: number;
}

export interface SdkConfig {
  defaultModel: string;
  maxSessions: number;
}

export interface AppConfig {
  repos: RepoEntry[];
  workspaceRoot: string;
  channels: {
    telegram: ChannelConfig;
    web: ChannelConfig;
  };
  server: ServerConfig;
  sdk: SdkConfig;
}

export type EventType =
  | 'session_updated'
  | 'session_closed'
  | 'session_removed'
  | 'sessions_purged'
  | 'agent_stream'
  | 'channel_message'
  | 'question'
  | 'hello'
  | 'pong';

export interface AppEvent {
  type: EventType;
  [key: string]: unknown;
}
