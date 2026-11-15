import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { dispatchAgent } from './agent.js';

const app = new Hono();

const livekitUrl = process.env.LIVEKIT_URL!;
const apiKey = process.env.LIVEKIT_API_KEY!;
const apiSecret = process.env.LIVEKIT_API_SECRET!;

const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);

app.post('/webhooks/chert', async (c) => {
  const body = await c.req.json();
  const { event, call } = body;

  if (event !== 'call.incoming') {
    return c.json({ status: 'ignored' });
  }

  const callId: string = call.id;
  const roomName = `show-and-say-${callId}`;

  // Create the LiveKit room
  await roomService.createRoom({ name: roomName });

  // Bridge token for Chert to join the room
  const bridgeToken = new AccessToken(apiKey, apiSecret, {
    identity: 'chert-bridge',
    ttl: '10m',
  });
  bridgeToken.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

  // Dispatch our agent into the room
  await dispatchAgent(roomName, callId);

  return c.json({
    action: 'accept',
    livekit_url: livekitUrl,
    bridge_token: await bridgeToken.toJwt(),
    agent_identity: 'show-and-say-agent',
  });
});

app.get('/health', (c) => c.json({ status: 'ok' }));

const port = parseInt(process.env.PORT ?? '3000', 10);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Webhook server listening on http://localhost:${port}`);
});
