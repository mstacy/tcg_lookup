"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  onReady?: () => void;
};

function describeError(err: unknown): string {
  if (!window.isSecureContext) return "Camera needs HTTPS. Open the app over https:// or on localhost.";
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "Camera permission was denied. Allow it in your browser settings and reload.";
    if (err.name === "NotFoundError") return "No camera found on this device.";
    if (err.name === "NotReadableError") return "The camera is in use by another app.";
  }
  return "Could not start the camera.";
}

export default function CameraView({ videoRef, onReady }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceIndex, setDeviceIndex] = useState<number | null>(null);

  const start = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(describeError(null));
      return null;
    }
    const deviceId = deviceIndex !== null ? devices[deviceIndex]?.deviceId : undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {});
        onReady?.();
      }
      // Device labels are only populated after permission is granted.
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "videoinput"));
      return stream;
    } catch (err) {
      setError(describeError(err));
      return null;
    }
    // `devices` only matters when deviceIndex changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceIndex, videoRef, onReady]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    start().then((s) => {
      if (cancelled) s?.getTracks().forEach((t) => t.stop());
      else stream = s;
    });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [start]);

  const switchCamera = () => {
    if (devices.length < 2) return;
    const current = (videoRef.current?.srcObject as MediaStream | null)?.getVideoTracks()[0]?.getSettings().deviceId;
    const currentIndex = devices.findIndex((d) => d.deviceId === current);
    setDeviceIndex((currentIndex + 1) % devices.length);
  };

  return (
    <>
      <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-neutral-950 p-6 text-center">
          <p className="max-w-sm text-neutral-200">{error}</p>
          <button onClick={start} className="rounded-full bg-white px-5 py-2 font-medium text-neutral-900">
            Try again
          </button>
        </div>
      )}
      {devices.length > 1 && !error && (
        <button
          onClick={switchCamera}
          aria-label="Switch camera"
          className="absolute right-3 top-3 rounded-full bg-black/50 px-3 py-2 text-sm text-white backdrop-blur"
        >
          Switch camera
        </button>
      )}
    </>
  );
}
