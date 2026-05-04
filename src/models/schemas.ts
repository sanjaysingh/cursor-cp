/**
 * Zod schemas for request/response validation
 */

import { z } from 'zod';

export const CreateSessionRequest = z.object({
  repoPath: z.string().optional(),
  title: z.string().default(''),
  model: z.string().optional(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const SendSessionMessageRequest = z.object({
  text: z.string().min(1, 'text is required'),
});

export type SendSessionMessageRequest = z.infer<typeof SendSessionMessageRequest>;

export const AnswerQuestionRequest = z.object({
  answer: z.string(),
  optionIndex: z.number().optional(),
});

export type AnswerQuestionRequest = z.infer<typeof AnswerQuestionRequest>;

export const CloneRepoRequest = z.object({
  nameWithOwner: z.string().min(1, 'nameWithOwner is required'),
});

export type CloneRepoRequest = z.infer<typeof CloneRepoRequest>;

export const UpdateDefaultModelRequest = z.object({
  model: z.string().optional(),
});

export type UpdateDefaultModelRequest = z.infer<typeof UpdateDefaultModelRequest>;

// API Compatibility Types
export const CreateRunRequest = z.object({
  conversationId: z.string().default('web:default'),
  repoPath: z.string(),
  prompt: z.string(),
});

export type CreateRunRequest = z.infer<typeof CreateRunRequest>;
