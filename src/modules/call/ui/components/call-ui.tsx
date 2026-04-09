"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StreamTheme, useCall } from "@stream-io/video-react-sdk";
import { ErrorBoundary } from "react-error-boundary";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";

import { CallLobby } from "./call-lobby";
import { CallActive } from "./call-active";
import { CallEnded } from "./call-ended";

interface Props {
  meetingName: string;
  onCallLeft?: () => void;
};

const CallErrorFallback = ({ resetErrorBoundary }: { resetErrorBoundary: () => void }) => (
  <div className="flex h-full flex-col items-center justify-center gap-6 bg-[#0f1117] text-white">
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500/15">
        <AlertTriangleIcon className="size-8 text-red-400" />
      </div>
      <h3 className="text-lg font-semibold">Something went wrong</h3>
      <p className="max-w-xs text-sm text-white/60">
        The call encountered an unexpected error. This can happen if the network
        dropped or the AI agent disconnected. Try rejoining.
      </p>
    </div>
    <button
      onClick={resetErrorBoundary}
      className="flex items-center gap-2 rounded-full bg-white/10 px-5 py-2.5 text-sm font-medium transition hover:bg-white/20"
    >
      <RefreshCwIcon className="size-4" />
      Try again
    </button>
  </div>
);

export const CallUI = ({ meetingName, onCallLeft }: Props) => {
  const call = useCall();
  const router = useRouter();
  const [show, setShow] = useState<"lobby" | "call" | "ended">("lobby");

  const handleJoin = async () => {
    if (!call) return;

    await call.join();

    setShow("call");
  };

  const handleLeave = () => {
    onCallLeft?.();
    router.push("/meetings");
  };

  return (
    <StreamTheme className="h-full">
      {show === "lobby" && <CallLobby onJoin={handleJoin} />}
      {show === "call" && (
        <ErrorBoundary
          FallbackComponent={CallErrorFallback}
          onReset={() => setShow("lobby")}
        >
          <CallActive onLeave={handleLeave} meetingName={meetingName} />
        </ErrorBoundary>
      )}
      {show === "ended" && <CallEnded />}
    </StreamTheme>
  )
};
