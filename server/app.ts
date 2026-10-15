import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyError, LogController } from 'fastify';
import { ZodError } from 'zod';
import { type JiraConfig, rooms } from './rooms.ts';

export async function buildApp({ jira, webRoot, gatewayToken }: { jira: JiraConfig; webRoot?: string; gatewayToken?: string }) {
  if (gatewayToken !== undefined && gatewayToken.length < 32) throw new Error('The gateway token must have at least 32 characters');
  // No request logging: session URLs are invite links, and nothing from a request may reach the logs.
  const app = Fastify({ trustProxy: true, logger: true, logController: new LogController({ disableRequestLogging: true }) });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 } });
  if (gatewayToken !== undefined) {
    const expected = createHash('sha256').update(gatewayToken).digest();
    app.addHook('onRequest', async (req, reply) => {
      const supplied = req.headers['x-sprint-gateway-auth'];
      const actual = createHash('sha256').update(typeof supplied === 'string' ? supplied : '').digest();
      if (!timingSafeEqual(expected, actual)) return reply.header('connection', 'close').code(404).send({ error: 'Not found' });
    });
  }
  app.setErrorHandler<FastifyError>((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues[0].message });
    if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Internal error' });
  });

  rooms(app, jira);

  const spa = webRoot !== undefined && existsSync(join(webRoot, 'index.html'));
  if (spa) await app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((req, reply) =>
    spa && req.method === 'GET' && !req.url.startsWith('/api/')
      ? reply.sendFile('index.html')
      : reply.code(404).send({ error: 'Not found' }),
  );

  return app;
}
