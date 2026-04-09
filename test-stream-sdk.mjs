import { StreamClient } from '@stream-io/node-sdk';
import { createRealtimeClient } from '@stream-io/openai-realtime-api';
import 'dotenv/config';

async function test() {
  const streamClient = new StreamClient(
    process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY,
    process.env.STREAM_VIDEO_SECRET_KEY,
  );

  const meetingId = 'dummy_test_meeting_123';
  const token = streamClient.generateUserToken({
    user_id: 'test_agent',
    validity_in_seconds: 7200,
  });

  const realtimeClient = createRealtimeClient({
    baseUrl: 'https://video.stream-io-api.com',
    call: { type: 'default', id: meetingId, cid: `default:${meetingId}` },
    streamApiKey: process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY,
    streamUserToken: token,
    openAiApiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-realtime-preview-2024-12-17'
  });
  
  realtimeClient.realtime.on('client.*', (event) => console.log("CLIENT MSG:", event.type));
  realtimeClient.realtime.on('server.*', (event) => console.log("SERVER MSG:", event.type, event.error || ''));
  
  // Also hook the raw websocket
  const oldConnect = realtimeClient.realtime.connect;
  realtimeClient.realtime.connect = function(...args) {
    const res = oldConnect.apply(this, args);
    this.ws.on('message', (msg) => console.log("RAW WS MSG:", msg.toString()));
    return res;
  };

  try {
    await realtimeClient.connect();
    console.log("Connected successfully!");
  } catch (e) {
    console.log("Connect error:", e);
  }
}
test();
