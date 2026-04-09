import { StreamClient } from "@stream-io/node-sdk";
import "dotenv/config";
import { setTimeout } from "timers/promises";

async function test() {
  const client = new StreamClient(
    process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY as string,
    process.env.STREAM_VIDEO_SECRET_KEY as string,
  );

  const callId = "test-ai-meeting-" + Date.now();
  const call = client.video.call("default", callId);
  await call.create({ data: { created_by_id: "test-user-1" } });

  console.log(`[TEST] Call created: ${callId}`);

  await client.upsertUsers([
    { id: "test-agent-1", name: "Test AI Agent", role: "admin" },
    { id: "test-user-1", name: "Test Human", role: "user" }
  ]);

  await call.updateCallMembers({
    update_members: [
      { user_id: "test-agent-1" },
      { user_id: "test-user-1" }
    ]
  });

  console.log("[TEST] Members updated. Connecting OpenAI agent...");
  
  const realtimeClient = await client.video.connectOpenAi({
    call,
    openAiApiKey: process.env.OPENAI_API_KEY as string,
    agentUserId: "test-agent-1",
    model: "gpt-4o-realtime-preview-2024-10-01",
  });

  console.log("[TEST] Agent connected OpenAi client!");

  realtimeClient.updateSession({
    instructions: "You are a helpful assistant.",
    modalities: ["audio", "text"],
    voice: "alloy",
    input_audio_transcription: { model: "whisper-1" },
  });

  console.log("[TEST] Inspecting realtimeClient...");
  const keys = Object.getOwnPropertyNames(realtimeClient);
  console.log("Keys on realtimeClient:", keys);
  
  if (realtimeClient.realtime) {
    console.log("Keys on realtimeClient.realtime:", Object.getOwnPropertyNames(realtimeClient.realtime));
  }
  
  // Try to find the raw socket in child properties
  for (const k in realtimeClient) {
    if (typeof (realtimeClient as any)[k] === 'object' && (realtimeClient as any)[k] !== null) {
      if ((realtimeClient as any)[k].ws) {
        console.log(`Found .ws inside realtimeClient.${k}`);
      }
    }
  }

  // Attempt to use 'api' or 'client'
  try {
    if ((realtimeClient as any).realtime?.api?.ws) {
        console.log("FOUND API WS!");
    } else if ((realtimeClient as any).realtime?.client?.ws) {
        console.log("FOUND CLIENT WS!");
    } else {
        console.log("NO WS FOUND IMMEDIATELY - MAY BE DELAYED.");
    }
  } catch(e){}

  await realtimeClient.disconnect();
  console.log("[TEST] Complete.");
}

test();
