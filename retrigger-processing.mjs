import "dotenv/config";
import { Inngest } from "inngest";
import { neon } from "@neondatabase/serverless";

const meetingId = process.argv[2];

if (!meetingId) {
  console.error("Usage: node retrigger-processing.mjs <meetingId>");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);
const rows = await sql`SELECT transcript_url FROM meetings WHERE id = ${meetingId}`;
const transcriptUrl = rows[0]?.transcript_url;

if (!transcriptUrl) {
  console.error(`No transcript_url found for meeting ${meetingId}`);
  process.exit(1);
}

const inngest = new Inngest({ id: "meet-ai-2" });
const result = await inngest.send({
  name: "meetings/processing",
  data: {
    meetingId,
    transcriptUrl,
  },
});

console.log("Triggered meetings/processing:", JSON.stringify(result));
