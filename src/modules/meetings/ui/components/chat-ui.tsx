import { useState, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Channel as StreamChannel } from "stream-chat";
import {
  useCreateChatClient,
  Chat,
  Channel,
  MessageInput,
  MessageList,
  Thread,
  Window,
} from "stream-chat-react";

import { useTRPC } from "@/trpc/client";
import { LoadingState } from "@/components/loading-state";

import "stream-chat-react/dist/css/v2/index.css";

interface ChatUIProps {
  meetingId: string;
  meetingName: string;
  userId: string;
  userName: string;
  userImage: string | undefined;
};

export const ChatUI = ({
  meetingId,
  meetingName,
  userId,
  userName,
  userImage,
}: ChatUIProps) => {
  const trpc = useTRPC();
  const { mutateAsync: generateChatToken } = useMutation(
    trpc.meetings.generateChatToken.mutationOptions(),
  );
  const { mutateAsync: askAi } = useMutation(
    trpc.meetings.askAi.mutationOptions(),
  );

  const [channel, setChannel] = useState<StreamChannel>();
  const handledMessageIdsRef = useRef<Set<string>>(new Set());
  const client = useCreateChatClient({
    apiKey: process.env.NEXT_PUBLIC_STREAM_CHAT_API_KEY!,
    tokenOrProvider: generateChatToken,
    userData: {
      id: userId,
      name: userName,
      image: userImage,
    },
  });

  useEffect(() => {
    if (!client) return;

    const channel = client.channel("messaging", meetingId, {
      members: [userId],
    });

    setChannel(channel);
  }, [client, meetingId, meetingName, userId]);

  useEffect(() => {
    if (!channel) return;

    const subscription = channel.on("message.new", (event) => {
      const incoming = event.message;
      if (!incoming?.id || !incoming.text?.trim()) return;
      if (event.user?.id !== userId) return;
      if (handledMessageIdsRef.current.has(incoming.id)) return;

      handledMessageIdsRef.current.add(incoming.id);

      // Fallback mode for Ask AI when message.new webhook isn't configured.
      // Wait briefly; if no assistant response appears, trigger server-side reply directly.
      setTimeout(async () => {
        const sentAt = incoming.created_at ? new Date(incoming.created_at).getTime() : Date.now();
        const hasAssistantReply = channel.state.messages.some((msg) => {
          if (!msg.text?.trim()) return false;
          if (!msg.user?.id || msg.user.id === userId) return false;
          const msgAt = msg.created_at ? new Date(msg.created_at).getTime() : 0;
          return msgAt >= sentAt;
        });

        if (hasAssistantReply) return;

        try {
          await askAi({
            meetingId,
            text: incoming.text ?? "",
          });
        } catch (error) {
          console.error("Ask AI fallback failed:", error);
        }
      }, 4000);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [askAi, channel, meetingId, userId]);

  if (!client) {
    return (
      <LoadingState
        title="Loading Chat"
        description="This may take a few seconds"
      />
    );
  }

  return (
    <div className="bg-white rounded-lg border overflow-hidden">
      <Chat client={client}>
        <Channel channel={channel}>
          <Window>
            <div className="flex-1 overflow-y-auto max-h-[calc(100vh-23rem)] border-b">
              <MessageList />
            </div>
            <MessageInput />
          </Window>
          <Thread />
        </Channel>
      </Chat>
    </div>
  )
}