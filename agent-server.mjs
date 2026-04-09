/**
 * agent-server.mjs
 * 
 * A standalone persistent Node.js server that:
 * 1. Listens for HTTP POST /connect-agent with { meetingId, agentId, agentName, instructions }
 * 2. Creates and holds a Stream-OpenAI realtime WebSocket connection for the duration of the call
 * 3. Properly cleans up when the session ends via POST /disconnect-agent { meetingId }
 * 
 * This runs OUTSIDE of Next.js to avoid request-lifecycle GC issues.
 */

import http from 'http';
import { StreamClient } from '@stream-io/node-sdk';
import { createRealtimeClient } from '@stream-io/openai-realtime-api';
import dotenv from 'dotenv';

dotenv.config({ override: true });

// Surface all unhandled failures so the process doesn't silently die
process.on('uncaughtException', (err) => {
  console.error('[agent-server] ❌ uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[agent-server] ❌ unhandledRejection:', reason);
});

const PORT = 3001;

// Map of meetingId -> realtimeClient
const activeClients = new Map();

const streamClient = new StreamClient(
  process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY,
  process.env.STREAM_VIDEO_SECRET_KEY,
);

function attachRealtimeListeners(realtimeClient, meetingId) {
  // Set up disconnect handling
  realtimeClient.on?.('close', () => {
    console.log(`[agent-server] Agent disconnected for meeting ${meetingId}`);
    activeClients.delete(meetingId);
  });

  realtimeClient.on?.('error', (event) => {
    console.error(`[agent-server] Agent error for ${meetingId}:`, event);
  });

  // Log when the agent hears speech
  realtimeClient.on?.('input_audio_buffer.speech_started', () => {
    console.log(`[agent-server] [${meetingId}] Agent heard speech!`);
  });

  realtimeClient.on?.('response.created', () => {
    console.log(`[agent-server] [${meetingId}] Agent is generating response...`);
  });

  realtimeClient.on?.('response.done', () => {
    console.log(`[agent-server] [${meetingId}] Agent finished responding.`);
  });
  realtimeClient.on?.('session.created', () => {
    console.log(`[agent-server] [${meetingId}] Realtime session created.`);
  });
  realtimeClient.on?.('session.updated', () => {
    console.log(`[agent-server] [${meetingId}] Realtime session updated.`);
  });
}

async function connectAgent({ meetingId, agentUserId, agentName, instructions }) {
  if (activeClients.has(meetingId)) {
    console.log(`[agent-server] Agent already active for ${meetingId}, skipping.`);
    return { status: 'already_active' };
  }

  console.log(`[agent-server] Connecting agent for meeting ${meetingId}...`);

  // Upsert the agent user
  await streamClient.upsertUsers([{
    id: agentUserId,
    name: agentName,
    role: 'user',
    custom: { isAgent: true },
  }]);

  const call = streamClient.video.call('default', meetingId);

  // Add agent as a call member
  try {
    await call.updateCallMembers({ update_members: [{ user_id: agentUserId }] });
  } catch (e) {
    console.warn(`[agent-server] updateCallMembers failed (may already be a member):`, e.message);
  }

  let realtimeClient;

  // Preferred path: Stream's official helper establishes a fully wired agent bridge.
  try {
    realtimeClient = await streamClient.video.connectOpenAi({
      call,
      openAiApiKey: process.env.OPENAI_API_KEY,
      agentUserId,
    });
    attachRealtimeListeners(realtimeClient, meetingId);
    console.log(`[agent-server] ✅ Agent connected via streamClient.video.connectOpenAi for ${meetingId}`);
  } catch (officialErr) {
    const detail = officialErr instanceof Error ? officialErr.message : String(officialErr);
    console.warn(`[agent-server] connectOpenAi failed, falling back to manual realtime client: ${detail}`);

    // Fallback path: direct realtime client.
    const token = streamClient.generateUserToken({
      user_id: agentUserId,
      validity_in_seconds: 7200,
    });

    realtimeClient = createRealtimeClient({
      baseUrl: 'https://video.stream-io-api.com',
      call: { type: 'default', id: meetingId, cid: `default:${meetingId}` },
      streamApiKey: process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY,
      streamUserToken: token,
      openAiApiKey: process.env.OPENAI_API_KEY,
      model: 'gpt-4o-realtime-preview-2024-12-17',
    });

    // Diagnostic: log the exact WebSocket URL the SDK will connect to
    const wsUrl = realtimeClient.realtime?.url;
    console.log(`[agent-server] [${meetingId}] Connecting to WebSocket URL: ${wsUrl}`);
    await realtimeClient.connect();
    attachRealtimeListeners(realtimeClient, meetingId);
    console.log(`[agent-server] ✅ Agent connected to Stream proxy (fallback) for ${meetingId}`);
  }

  // Configure the session via session.update.
  realtimeClient.updateSession?.({
    instructions: instructions || 'You are a helpful AI assistant.',
    modalities: ['audio', 'text'],
    voice: 'alloy',
    input_audio_transcription: { model: 'whisper-1' },
    turn_detection: {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 500,
    },
  });
  console.log(`[agent-server] [${meetingId}] Session configured`);

  // Store it persistently
  activeClients.set(meetingId, realtimeClient);
  console.log(`[agent-server] Agent session configured for ${meetingId}. Active sessions: ${activeClients.size}`);

  // Trigger a welcome greeting after the WebSocket stabilizes.
  // The realtime socket may report connected slightly before it's ready to send.
  const injectWelcome = (attempt = 1) => {
    try {
      if (typeof realtimeClient.sendUserMessageContent !== 'function') {
        throw new Error('sendUserMessageContent is unavailable on realtime client');
      }
      realtimeClient.sendUserMessageContent([
        { type: 'input_text', text: "Hello! Please greet the user and briefly introduce yourself." },
      ]);
      console.log(`[agent-server] [${meetingId}] Welcome message injected.`);
      return;
    } catch (e) {
      const message = e?.message || String(e);
      if (attempt < 15 && message.toLowerCase().includes('not connected')) {
        const delay = 1000;
        console.warn(`[agent-server] [${meetingId}] Welcome injection deferred (attempt ${attempt}): ${message}`);
        setTimeout(() => injectWelcome(attempt + 1), delay);
        return;
      }
      console.error(`[agent-server] [${meetingId}] Error injecting welcome:`, message);
    }
  };
  setTimeout(() => injectWelcome(1), 1500);

  return { status: 'connected' };
}

async function disconnectAgent(meetingId) {
  const client = activeClients.get(meetingId);
  if (!client) {
    return { status: 'not_found' };
  }
  try {
    await client.disconnect?.();
  } catch {}
  activeClients.delete(meetingId);
  console.log(`[agent-server] Disconnected agent for ${meetingId}`);
  return { status: 'disconnected' };
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);

      if (req.url === '/connect-agent') {
        const result = await connectAgent(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } else if (req.url === '/disconnect-agent') {
        const result = await disconnectAgent(data.meetingId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } else if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: [...activeClients.keys()] }));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    } catch (e) {
      console.error('[agent-server] Error:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[agent-server] Persistent agent server running on http://localhost:${PORT}`);
  console.log(`[agent-server] Endpoints:`);
  console.log(`  POST /connect-agent    { meetingId, agentUserId, agentName, instructions }`);
  console.log(`  POST /disconnect-agent { meetingId }`);
  console.log(`  POST /status`);
});

// Keep alive — prevent Node.js from exiting
setInterval(() => {}, 60000);
