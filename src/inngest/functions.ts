import { eq, inArray } from "drizzle-orm";
import JSONL from "jsonl-parse-stringify";
import { createAgent, openai, TextMessage } from "@inngest/agent-kit";
import dotenv from "dotenv";

import { db } from "@/db";
import { agents, meetings, user } from "@/db/schema";
import { inngest } from "@/inngest/client";
import { streamVideo } from "@/lib/stream-video";

import { StreamTranscriptItem } from "@/modules/meetings/types";

dotenv.config({ override: true });

export const meetingsProcessing = inngest.createFunction(
  { id: "meetings/processing" },
  { event: "meetings/processing" },
  async ({ event, step }) => {
    try {
      const response = await step.run("fetch-transcript", async () => {
        return fetch(event.data.transcriptUrl).then((res) => res.text());
      });

      const transcript = await step.run("parse-transcript", async () => {
        return JSONL.parse<StreamTranscriptItem>(response);
      });

      const transcriptWithSpeakers = await step.run("add-speakers", async () => {
        const speakerIds = [
          ...new Set(transcript.map((item) => item.speaker_id)),
        ];

        const userSpeakers = await db
          .select()
          .from(user)
          .where(inArray(user.id, speakerIds))
          .then((users) =>
            users.map((user) => ({
              ...user,
            }))
          );

        const agentSpeakers = await db
          .select()
          .from(agents)
          .where(inArray(agents.id, speakerIds))
          .then((agents) =>
            agents.map((agent) => ({
              ...agent,
            }))
          );

        const speakers = [...userSpeakers, ...agentSpeakers];

        return transcript.map((item) => {
          const speaker = speakers.find(
            (speaker) => speaker.id === item.speaker_id
          );

          if (!speaker) {
            return {
              ...item,
              user: {
                name: "Unknown",
              },
            };
          }

          return {
            ...item,
            user: {
              name: speaker.name,
            },
          };
        });
      });

      const summarizer = createAgent({
        name: "summarizer",
        system: `
    You are an expert summarizer. You write readable, concise, simple content. You are given a transcript of a meeting and you need to summarize it.

Use the following markdown structure for every output:

### Overview
Provide a detailed, engaging summary of the session's content. Focus on major features, user workflows, and any key takeaways. Write in a narrative style, using full sentences. Highlight unique or powerful aspects of the product, platform, or discussion.

### Notes
Break down key content into thematic sections with timestamp ranges. Each section should summarize key points, actions, or demos in bullet format.

Example:
#### Section Name
- Main point or demo shown here
- Another key insight or interaction
- Follow-up tool or explanation provided

#### Next Section
- Feature X automatically does Y
- Mention of integration with Z
  `.trim(),
        model: openai({ model: "gpt-4o", apiKey: process.env.OPENAI_API_KEY }),
      });

      const { output } = await summarizer.run(
        "Summarize the following transcript: " +
          JSON.stringify(transcriptWithSpeakers)
      );

      const summaryText = (() => {
        const first = output?.[0] as TextMessage | undefined;
        if (typeof first?.content === "string" && first.content.trim().length > 0) {
          return first.content;
        }
        if (Array.isArray(first?.content)) {
          const joined = first.content
            .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
            .join(" ")
            .trim();
          if (joined) return joined;
        }
        return "Summary generation returned an empty response.";
      })();

      await step.run("save-summary", async () => {
        await db
          .update(meetings)
          .set({
            summary: summaryText,
            status: "completed",
          })
          .where(eq(meetings.id, event.data.meetingId));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.run("save-summary-fallback", async () => {
        await db
          .update(meetings)
          .set({
            summary: `Summary generation failed: ${message}`,
            status: "completed",
          })
          .where(eq(meetings.id, event.data.meetingId));
      });
    }
  },
);

export const meetingsAssetsSync = inngest.createFunction(
  { id: "meetings/assets-sync" },
  { event: "meetings/assets-sync" },
  async ({ event, step }) => {
    const meetingId = event.data.meetingId as string;

    const pickUrl = (items: unknown): string | null => {
      if (!Array.isArray(items) || items.length === 0) return null;
      const first = items[0] as Record<string, unknown>;
      const url = first?.url;
      return typeof url === "string" ? url : null;
    };

    let transcriptUrl: string | null = null;
    let recordingUrl: string | null = null;

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const assets = await step.run(`fetch-assets-attempt-${attempt}`, async () => {
        const call = streamVideo.video.call("default", meetingId);

        const [transcriptionsResponse, recordingsResponse] = await Promise.all([
          call.listTranscriptions().catch(() => null),
          call.listRecordings().catch(() => null),
        ]);

        const transcriptions =
          (transcriptionsResponse as { transcriptions?: unknown[] } | null)?.transcriptions ?? [];
        const recordings =
          (recordingsResponse as { recordings?: unknown[] } | null)?.recordings ?? [];

        return {
          transcriptUrl: pickUrl(transcriptions),
          recordingUrl: pickUrl(recordings),
        };
      });

      transcriptUrl = assets.transcriptUrl ?? transcriptUrl;
      recordingUrl = assets.recordingUrl ?? recordingUrl;

      if (transcriptUrl || recordingUrl) {
        break;
      }

      await step.sleep(`wait-before-retry-${attempt}`, "30s");
    }

    await step.run("save-assets", async () => {
      await db
        .update(meetings)
        .set({
          transcriptUrl: transcriptUrl ?? undefined,
          recordingUrl: recordingUrl ?? undefined,
        })
        .where(eq(meetings.id, meetingId));
    });

    if (transcriptUrl) {
      await step.run("trigger-processing", async () => {
        await inngest.send({
          name: "meetings/processing",
          data: {
            meetingId,
            transcriptUrl,
          },
        });
      });
    }
  }
);

