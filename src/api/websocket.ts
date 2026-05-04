/**
 * WebSocket handler for real-time events
 */

import type { FastifyInstance } from 'fastify';
import type { EventBus } from '../core/events.js';
import type { AppEvent } from '../models/types.js';

export function registerWebSocket(
  fastify: FastifyInstance,
  eventBus: EventBus
): void {
  fastify.get('/ws', { websocket: true }, (connection, _req) => {
    const socket = connection.socket;

    // Handler for events
    const handleEvent = (event: AppEvent): void => {
      try {
        socket.send(JSON.stringify(event));
      } catch {
        // Socket might be closed
      }
    };

    // Subscribe to all events
    const unsubscribe = eventBus.on('*', handleEvent);

    // Send hello
    socket.send(JSON.stringify({ type: 'hello' }));

    // Handle incoming messages
    socket.on('message', (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (data.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // Ignore invalid messages
      }
    });

    // Cleanup on close
    socket.on('close', () => {
      unsubscribe();
    });
  });
}
