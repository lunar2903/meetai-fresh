import OpenAI from "openai";
import 'dotenv/config';

async function testOpenAI() {
  console.log("Key:", process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.substring(0, 15) + "..." : "missing");
  const openai = new OpenAI();
  try {
    const models = await openai.models.list();
    console.log("OpenAI is working, num models:", models.data.length);
  } catch (error) {
    console.error("OpenAI Error:", error.message);
  }
}
testOpenAI();
