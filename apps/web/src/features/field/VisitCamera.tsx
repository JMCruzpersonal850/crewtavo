/**
 * The visit's own camera: a dialog that opens the phone's back camera, lets the crew take as
 * many shots as they like in one go, look them over in a strip (and drop the bad ones), then
 * adds them all to the visit's photos at once — they go through the same queue as picked photos
 * (useVisitPhotos), so they upload when there's signal. When the camera can't open — no
 * permission, or a browser that can't reach one — it says so in plain words and points at
 * "Add photos", which still works; it never sits blank.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { t } from "@/lib/i18n";

interface Shot { blob: Blob; url: string; name: string }

export function VisitCamera({ onAdd, onClose }: { onAdd: (files: File[]) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const shotsRef = useRef<Shot[]>([]);
  const taken = useRef(0);
  const [shots, setShots] = useState<Shot[]>([]);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);

  useEffect(() => {
    let gone = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setProblem(t("This browser can't open a camera here. Crewtavo needs a secure connection and a newer browser for the camera."));
    } else {
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: "environment" }, audio: false })
        .then((opened) => {
          if (gone) {
            opened.getTracks().forEach((track) => track.stop());
            return;
          }
          stream.current = opened;
          if (video.current) video.current.srcObject = opened;
        })
        .catch((error: unknown) => {
          if (gone) return;
          setProblem(
            error instanceof DOMException && error.name === "NotAllowedError"
              ? t("Crewtavo doesn't have permission to use the camera. Allow camera access for this site in your browser settings, then try again.")
              : t("The camera couldn't be opened. It may be in use by another app — close that app and try again."),
          );
        });
    }
    return () => {
      gone = true;
      stopCamera();
      shotsRef.current.forEach((shot) => URL.revokeObjectURL(shot.url));
      shotsRef.current = [];
    };
  }, [stopCamera]);

  const close = () => {
    stopCamera();
    onClose();
  };

  const capture = () => {
    const view = video.current;
    if (!view || !view.videoWidth || !view.videoHeight) return;
    const canvas = document.createElement("canvas");
    canvas.width = view.videoWidth;
    canvas.height = view.videoHeight;
    canvas.getContext("2d")?.drawImage(view, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        taken.current += 1;
        const stamp = Date.now();
        const shot: Shot = { blob, url: URL.createObjectURL(blob), name: taken.current === 1 ? `photo-${stamp}.jpg` : `photo-${stamp}-${taken.current}.jpg` };
        shotsRef.current = [...shotsRef.current, shot];
        setShots(shotsRef.current);
      },
      "image/jpeg",
      0.9,
    );
  };

  const drop = (shot: Shot) => {
    URL.revokeObjectURL(shot.url);
    shotsRef.current = shotsRef.current.filter((s) => s !== shot);
    setShots(shotsRef.current);
  };

  const addAll = () => {
    const files = shotsRef.current.map((shot) => new File([shot.blob], shot.name, { type: "image/jpeg" }));
    if (files.length) onAdd(files);
    close();
  };

  return (
    <Dialog open onClose={close} title={t("Camera")} focusField={false} size="lg">
      <div className="dialog-body">
        {problem ? (
          <>
            <p>{problem}</p>
            <p className="field-hint">{t("You can still add photos with “Add photos” on the visit — it uses your phone's camera and photo library instead.")}</p>
          </>
        ) : (
          <>
            <video ref={video} autoPlay playsInline muted onLoadedMetadata={() => setReady(true)} style={{ width: "100%", borderRadius: 10, background: "#000", aspectRatio: "4 / 3", objectFit: "cover" }} aria-label={t("Camera view")} />
            {shots.length > 0 && (
              <div className="thumbs" style={{ marginTop: 10 }}>
                {shots.map((shot) => (
                  <div key={shot.url} className="thumb">
                    <img src={shot.url} alt={shot.name} />
                    <button type="button" className="thumb-x" aria-label={t("Remove photo")} onClick={() => drop(shot)}><Icon name="x" size={12} bold /></button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <Button icon="camera" disabled={!ready} onClick={capture}>{t("Take photo")}</Button>
              <Button variant="primary" disabled={!shots.length} onClick={addAll}>{shots.length === 1 ? t("Add 1 photo") : t("Add {count} photos", { count: shots.length })}</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
