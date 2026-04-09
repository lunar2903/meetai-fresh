import Link from "next/link";
import Image from "next/image";
import { PhoneOffIcon } from "lucide-react";
import {
  PaginatedGridLayout,
  ToggleAudioPublishingButton,
  ToggleVideoPublishingButton,
  ScreenShareButton,
  ReactionsButton,
  RecordCallButton,
  useCall,
  useCallStateHooks,
  type VideoPlaceholderProps,
} from "@stream-io/video-react-sdk";

interface Props {
  onLeave: () => void;
  meetingName: string;
};

const CustomVideoPlaceholder = ({ participant, style }: VideoPlaceholderProps) => {
  return (
    <div
      style={{
        ...style,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: "12px",
        background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)",
      }}
    >
      {participant.image ? (
        <img
          src={participant.image}
          alt={participant.name || "Participant"}
          style={{
            width: "96px",
            height: "96px",
            borderRadius: "50%",
            objectFit: "cover",
            border: "3px solid rgba(255,255,255,0.15)",
            boxShadow: "0 4px 24px rgba(0,0,0,0.3)",
          }}
        />
      ) : (
        <div
          style={{
            width: "96px",
            height: "96px",
            borderRadius: "50%",
            background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "36px",
            fontWeight: 600,
            color: "white",
            border: "3px solid rgba(255,255,255,0.15)",
            boxShadow: "0 4px 24px rgba(0,0,0,0.3)",
          }}
        >
          {participant.name?.charAt(0)?.toUpperCase() || "?"}
        </div>
      )}
      <span
        style={{
          color: "rgba(255,255,255,0.85)",
          fontSize: "14px",
          fontWeight: 500,
        }}
      >
        {participant.name || "Unknown"}
      </span>
    </div>
  );
};

export const CallActive = ({ onLeave, meetingName }: Props) => {
  const call = useCall();
  const { useParticipants, useIsCallRecordingInProgress, useIsCallTranscribingInProgress } = useCallStateHooks();
  const participants = useParticipants();
  useIsCallRecordingInProgress();
  useIsCallTranscribingInProgress();

  const handleLeave = async () => {
    if (call) {
      try {
        await call.endCall();
      } catch {
        // Ignore - call may already be left // If error, probably lack permissions, fallback to leave
        try { await call.leave(); } catch {}
      }
    }
    onLeave();
  };

  return (
    <div className="flex flex-col justify-between p-4 h-full text-white">
      <div className="bg-[#101213] rounded-full p-4 flex items-center gap-4">
        <Link href="/" className="flex items-center justify-center p-1 bg-white/10 rounded-full w-fit">
          <Image src="/logo.svg" width={22} height={22} alt="Logo" />
        </Link>
        <h4 className="text-base">
          {meetingName} <span className="text-white/50 text-sm ml-2">({participants.length} Participant{participants.length !== 1 && 's'})</span>
        </h4>
      </div>
      <div className="relative flex-1 rounded-2xl overflow-hidden bg-black/20">
        <PaginatedGridLayout
          VideoPlaceholder={CustomVideoPlaceholder}
        />
        {participants.length === 1 && (
          <div className="absolute inset-0 bg-black/60 z-10 flex flex-col items-center justify-center p-8 text-center backdrop-blur-sm">
            <div className="w-24 h-24 mb-6 rounded-full bg-indigo-500/20 flex items-center justify-center animate-pulse">
              <PhoneOffIcon className="size-10 text-indigo-400" />
            </div>
            <h3 className="text-2xl font-bold text-white mb-3">
              The AI is connected & listening!
            </h3>
            <p className="text-white/70 max-w-md text-lg">
              Stream Video hides AI agents until they speak. <br/><br/>
              <b>Turn on your microphone and say &quot;Hello&quot;</b> to wake up your agent and begin the conversation!
            </p>
          </div>
        )}
      </div>
      <div className="bg-[#101213] rounded-full px-4">
        <div className="str-video__call-controls">
          <ToggleAudioPublishingButton />
          <ToggleVideoPublishingButton />
          <ReactionsButton />
          <ScreenShareButton />
          <RecordCallButton />
          <button
            className="str-video__call-controls__button str-video__end-call-button"
            onClick={handleLeave}
            title="Leave call"
          >
            <PhoneOffIcon className="size-5" />
          </button>
        </div>
      </div>
    </div>
  );
};
