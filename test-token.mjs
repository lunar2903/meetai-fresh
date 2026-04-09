import { StreamClient } from '@stream-io/node-sdk';
import 'dotenv/config';

const streamClient = new StreamClient(
  process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY,
  process.env.STREAM_VIDEO_SECRET_KEY,
);

const token1 = streamClient.generateUserToken({ user_id: 'test_agent' });
console.log("Token with object:", token1);

const token2 = streamClient.generateUserToken('test_agent');
console.log("Token with string:", token2);
