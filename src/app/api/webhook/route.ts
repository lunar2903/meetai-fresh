import OpenAI from "openai";
import fs from "node:fs";
import { and, eq, not } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import {
  MessageNewEvent,
  CallEndedEvent,
  CallTranscriptionReadyEvent,
  CallRecordingReadyEvent,
  CallSessionParticipantLeftEvent,
  CallSessionStartedEvent,
} from "@stream-io/node-sdk";

import { db } from "@/db";
import { agents, meetings } from "@/db/schema";
import { streamVideo } from "@/lib/stream-video";
import { inngest } from "@/inngest/client";
import { generateAvatarUri } from "@/lib/avatar";
import { streamChat } from "@/lib/stream-chat";

const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Keep realtime clients alive at the module level so they aren't garbage-collected
// when the webhook handler returns. Without this the WebSocket connections to
// Stream and OpenAI are dropped immediately after the HTTP response is sent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeRealtimeClients = new Map<string, any>();

function verifySignatureWithSDK(body: string, signature: string): boolean {
  return streamVideo.verifyWebhook(body, signature);
};

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing signature" },
      { status: 400 }
    );
  }

  const body = await req.text();

  if (!verifySignatureWithSDK(body, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = (payload as Record<string, unknown>)?.type;

  // DIAGNOSTIC LOG ALL EVENTS
  fs.appendFileSync('d:/Antigravity/meet-ai-fresh/webhook-debug.log', `[webhook ALL EVENTS] ${new Date().toISOString()}: Received event type: ${eventType}\n`);

  if (eventType === "call.session_started") {
    const event = payload as CallSessionStartedEvent;
    const meetingId = event.call.custom?.meetingId;

    if (!meetingId) {
      return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
    }

    console.log(`[webhook] call.session_started for meetingId: ${meetingId}`);
    fs.appendFileSync('d:/Antigravity/meet-ai-fresh/webhook-debug.log', `[webhook session_started] ${new Date().toISOString()}: meetingId: ${meetingId}\n`);

    const [existingMeeting] = await db
      .select()
      .from(meetings)
      .where(
        and(
          eq(meetings.id, meetingId),
          not(eq(meetings.status, "completed")),
          not(eq(meetings.status, "cancelled")),
          not(eq(meetings.status, "processing")),
        )
      );

    if (!existingMeeting) {
      console.log(`[webhook] Meeting not found or in terminal status for id: ${meetingId}`);
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    await db
      .update(meetings)
      .set({
        status: "active",
        startedAt: new Date(),
      })
      .where(eq(meetings.id, existingMeeting.id));

    // Start recording/transcription from the backend as a reliable fallback.
    // Client-side start can race with auth/session init and fail silently.
    try {
      const call = streamVideo.video.call("default", meetingId);
      await call.startRecording();
      fs.appendFileSync(
        "d:/Antigravity/meet-ai-fresh/webhook-debug.log",
        `[webhook recording_start] ${new Date().toISOString()}: started for meeting ${meetingId}\n`
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      fs.appendFileSync(
        "d:/Antigravity/meet-ai-fresh/webhook-debug.log",
        `[webhook recording_start_error] ${new Date().toISOString()}: ${message} for meeting ${meetingId}\n`
      );
      if (!message.toLowerCase().includes("already being recorded")) {
        console.warn(`[webhook] startRecording fallback failed for ${meetingId}: ${message}`);
      }
    }
    try {
      const call = streamVideo.video.call("default", meetingId);
      await call.startTranscription();
      fs.appendFileSync(
        "d:/Antigravity/meet-ai-fresh/webhook-debug.log",
        `[webhook transcription_start] ${new Date().toISOString()}: started for meeting ${meetingId}\n`
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      fs.appendFileSync(
        "d:/Antigravity/meet-ai-fresh/webhook-debug.log",
        `[webhook transcription_start_error] ${new Date().toISOString()}: ${message} for meeting ${meetingId}\n`
      );
      if (!message.toLowerCase().includes("already being transcribed")) {
        console.warn(`[webhook] startTranscription fallback failed for ${meetingId}: ${message}`);
      }
    }

    const [existingAgent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, existingMeeting.agentId));

    if (!existingAgent) {
      console.log(`[webhook] Agent not found for id: ${existingMeeting.agentId}`);
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // Deduplicate — Stream fires session_started multiple times
    if (activeRealtimeClients.has(meetingId)) {
      console.log(`[webhook] Agent already active for: ${meetingId}. Ignoring duplicate event.`);
      return NextResponse.json({ success: true, duplicate: true });
    }
    activeRealtimeClients.set(meetingId, true); // placeholder to block duplicates

    console.log(`[webhook] Delegating agent connection to persistent agent-server for: ${meetingId}`);

    try {
      // Delegate to the standalone agent-server.mjs process which holds the
      // WebSocket open for the full meeting. This avoids Next.js request lifecycle
      // killing our WebSocket connections after the HTTP response is sent.
      const agentServerResponse = await fetch('http://localhost:3001/connect-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingId,
          agentUserId: existingAgent.id,
          agentName: existingAgent.name,
          instructions: existingAgent.instructions,
        }),
      });

      const result = await agentServerResponse.json();

      // agent-server can respond with { error } and/or non-2xx when realtime connect fails.
      // Treat both as a failure and release dedupe lock so duplicate session_started events can retry.
      if (!agentServerResponse.ok || result?.error) {
        activeRealtimeClients.delete(meetingId);
        const details =
          typeof result?.error === "string"
            ? result.error
            : JSON.stringify(result);
        fs.appendFileSync(
          'd:/Antigravity/meet-ai-fresh/webhook-debug.log',
          `[webhook connectOpenAi Error] ${new Date().toISOString()}: agent-server rejected: ${details}\n`
        );
        return NextResponse.json(
          { error: "Failed to connect agent", details },
          { status: 502 }
        );
      }

      fs.appendFileSync('d:/Antigravity/meet-ai-fresh/webhook-debug.log',
        `[webhook connectOpenAi Success] ${new Date().toISOString()}: agent-server responded: ${JSON.stringify(result)} for meeting ${meetingId}\n`);
      console.log(`[webhook] agent-server response:`, result);

    } catch (error: unknown) {
      activeRealtimeClients.delete(meetingId);
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[webhook] Failed to reach agent-server:`, errorMsg);
      fs.appendFileSync('d:/Antigravity/meet-ai-fresh/webhook-debug.log',
        `[webhook connectOpenAi Error] ${new Date().toISOString()}: ${errorMsg}\n`);
      return NextResponse.json({ error: "Failed to connect", details: errorMsg }, { status: 500 });
    }
  } else if (eventType === "call.session_participant_left") {
    const event = payload as CallSessionParticipantLeftEvent;
    const meetingId = event.call_cid.split(":")[1]; // call_cid is formatted as "type:id"

    if (!meetingId) {
      return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
    }

    // Do nothing for now, just log. 
    // We should NOT end the entire call when a single participant leaves.
    console.log(`[webhook] Participant left call: ${meetingId}`);
  } else if (eventType === "call.session_ended") {
    const event = payload as CallEndedEvent;
    const meetingId = event.call.custom?.meetingId;

    if (!meetingId) {
      return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
    }

    // Clean up the realtime client when the call session ends.
    if (activeRealtimeClients.has(meetingId)) {
      console.log(`[webhook] Cleaning up realtime client for ended session: ${meetingId}`);
      try {
        await activeRealtimeClients.get(meetingId)?.disconnect?.();
      } catch {
        // Ignore cleanup errors
      }
      activeRealtimeClients.delete(meetingId);
    }

    await db
      .update(meetings)
      .set({
        status: "processing",
        endedAt: new Date(),
      })
      .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")));

    await inngest.send({
      name: "meetings/assets-sync",
      data: { meetingId },
    });
  } else if (eventType === "call.transcription_ready") {
    const event = payload as CallTranscriptionReadyEvent;
    const meetingId = event.call_cid.split(":")[1]; // call_cid is formatted as "type:id"

    const [updatedMeeting] = await db
      .update(meetings)
      .set({
        transcriptUrl: event.call_transcription.url,
      })
      .where(eq(meetings.id, meetingId))
      .returning();

    if (!updatedMeeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    await inngest.send({
      name: "meetings/processing",
      data: {
        meetingId: updatedMeeting.id,
        transcriptUrl: updatedMeeting.transcriptUrl,
      },
    });
  } else if (eventType === "call.recording_ready") {
    const event = payload as CallRecordingReadyEvent;
    const meetingId = event.call_cid.split(":")[1]; // call_cid is formatted as "type:id"

    await db
      .update(meetings)
      .set({
        recordingUrl: event.call_recording.url,
      })
      .where(eq(meetings.id, meetingId));
  } else if (eventType === "message.new") {
    const event = payload as MessageNewEvent;

    const userId = event.user?.id;
    const channelId = event.channel_id;
    const text = event.message?.text;

    if (!userId || !channelId || !text) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const [existingMeeting] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, channelId), eq(meetings.status, "completed")));

    if (!existingMeeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    const [existingAgent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, existingMeeting.agentId));

    if (!existingAgent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    if (userId !== existingAgent.id) {
      const instructions = `
      You are an AI assistant helping the user revisit a recently completed meeting.
      Below is a summary of the meeting, generated from the transcript:
      
      ${existingMeeting.summary}
      
      The following are your original instructions from the live meeting assistant. Please continue to follow these behavioral guidelines as you assist the user:
      
      ${existingAgent.instructions}
      
      The user may ask questions about the meeting, request clarifications, or ask for follow-up actions.
      Always base your responses on the meeting summary above.
      
      You also have access to the recent conversation history between you and the user. Use the context of previous messages to provide relevant, coherent, and helpful responses. If the user's question refers to something discussed earlier, make sure to take that into account and maintain continuity in the conversation.
      
      If the summary does not contain enough information to answer a question, politely let the user know.
      
      Be concise, helpful, and focus on providing accurate information from the meeting and the ongoing conversation.
      `;

      const channel = streamChat.channel("messaging", channelId);
      await channel.watch();

      const previousMessages = channel.state.messages
        .slice(-5)
        .filter((msg) => msg.text && msg.text.trim() !== "")
        .map<ChatCompletionMessageParam>((message) => ({
          role: message.user?.id === existingAgent.id ? "assistant" : "user",
          content: message.text || "",
        }));

      const GPTResponse = await openaiClient.chat.completions.create({
        messages: [
          { role: "system", content: instructions },
          ...previousMessages,
          { role: "user", content: text },
        ],
        model: "gpt-4o",
      });

      const GPTResponseText = GPTResponse.choices[0].message.content;

      if (!GPTResponseText) {
        return NextResponse.json(
          { error: "No response from GPT" },
          { status: 400 }
        );
      }

      const avatarUrl = generateAvatarUri({
        seed: existingAgent.name,
        variant: "botttsNeutral",
      });

      streamChat.upsertUser({
        id: existingAgent.id,
        name: existingAgent.name,
        image: avatarUrl,
      });

      channel.sendMessage({
        text: GPTResponseText,
        user: {
          id: existingAgent.id,
          name: existingAgent.name,
          image: avatarUrl,
        },
      });
    }
  }

  return NextResponse.json({ status: "ok" });
}
