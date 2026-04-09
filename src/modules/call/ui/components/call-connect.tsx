"use client";

import { LoaderIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Call,
  CallingState,
  StreamCall,
  StreamVideo,
  StreamVideoClient,
} from "@stream-io/video-react-sdk";

import "@stream-io/video-react-sdk/dist/css/styles.css";

import { useTRPC } from "@/trpc/client";

import { CallUI } from "./call-ui";

interface Props {
  meetingId: string;
  meetingName: string;
  userId: string;
  userName: string;
  userImage: string;
};

export const CallConnect = ({
  meetingId,
  meetingName,
  userId,
  userName,
  userImage,
}: Props) => {
  const trpc = useTRPC();
  const { mutateAsync: generateToken } = useMutation(
    trpc.meetings.generateToken.mutationOptions(),
  );

  // Store generateToken in a ref so the tokenProvider callback is stable
  // and doesn't cause the useEffect to re-fire on every render.
  const generateTokenRef = useRef(generateToken);
  generateTokenRef.current = generateToken;

  // Stable tokenProvider that never changes identity — prevents the
  // StreamVideoClient from being torn down on re-renders.
  const tokenProvider = useCallback(() => {
    return generateTokenRef.current();
  }, []);

  const [client, setClient] = useState<StreamVideoClient>();
  useEffect(() => {
    const _client = new StreamVideoClient({
      apiKey: process.env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY!,
      user: {
        id: userId,
        name: userName,
        image: userImage,
      },
      tokenProvider,
    });

    setClient(_client);

    return () => {
      _client.disconnectUser();
      setClient(undefined);
    };
    // tokenProvider is stable (useCallback with []), so this only re-runs
    // when the user identity actually changes.
  }, [userId, userName, userImage, tokenProvider]);

  const hasLeftRef = useRef(false);
  const [call, setCall] = useState<Call>();
  useEffect(() => {
      if (!client) return;
      hasLeftRef.current = false;

      const _call = client.call("default", meetingId);
      setCall(_call);

      return () => {
        if (
          !hasLeftRef.current &&
          _call.state.callingState !== CallingState.LEFT
        ) {
          _call.leave().catch(() => {
            // Ignore errors when the call was never joined or already left
          });
        }
        setCall(undefined);
      };
  }, [client, meetingId]);

  const handleLeave = () => {
    hasLeftRef.current = true;
  };

  if (!client || !call) {
    return (
      <div className="flex h-screen items-center justify-center bg-radial from-sidebar-accent to-sidebar">
        <LoaderIcon className="size-6 animate-spin text-white" />
      </div>
    );
  }

  return (
    <StreamVideo client={client}>
      <StreamCall call={call}>
        <CallUI meetingName={meetingName} onCallLeft={handleLeave} />
      </StreamCall>
    </StreamVideo>
  );
};
