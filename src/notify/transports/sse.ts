import type { FastifyReply } from 'fastify';
import type { JobEvent } from '../../types.js';

interface Client {
  reply: FastifyReply;
  jobId: string | null; // null = every job (the console)
}

const clients = new Set<Client>();

export function addClient(reply: FastifyReply, jobId: string | null): Client {
  const client: Client = { reply, jobId };
  clients.add(client);
  reply.raw.on('close', () => clients.delete(client));
  return client;
}

export function clientCount(): number {
  return clients.size;
}

export function writeEvent(reply: FastifyReply, event: JobEvent): void {
  reply.raw.write(`id: ${event.jobId}:${event.seq}\n`);
  reply.raw.write(`event: job\n`);
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function writeComment(reply: FastifyReply, text: string): void {
  reply.raw.write(`: ${text}\n\n`);
}

export async function broadcast(event: JobEvent): Promise<void> {
  for (const client of clients) {
    if (client.jobId !== null && client.jobId !== event.jobId) continue;
    try {
      writeEvent(client.reply, event);
    } catch {
      clients.delete(client);
    }
  }
}
