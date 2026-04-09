import { neon } from '@neondatabase/serverless';
import 'dotenv/config';

async function main() {
  const sql = neon(process.env.DATABASE_URL);
  
  // Check all meetings to see their status and if any previously had transcripts
  const allMeetings = await sql`SELECT id, status, transcript_url, recording_url, summary, created_at FROM meetings ORDER BY created_at DESC LIMIT 10`;
  console.log("All recent meetings:");
  console.table(allMeetings);
}
main();
