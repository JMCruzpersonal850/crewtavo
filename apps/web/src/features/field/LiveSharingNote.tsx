/**
 * Live sharing on the visit, while it's en route: this phone keeps the client's live map fed
 * (liveTracking.ts), the worker is told it's happening, and Stop sharing is theirs to tap.
 * Before the en_route_sharing notice is acknowledged nothing here reads the phone's place at
 * all — the LocationNotice on the same screens is what asks, and canShare stays false until
 * then. A sub never shares (their visits come by offer), and a company that turned live
 * tracking off (Settings → Client notifications) shows nothing here.
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { errorMessage } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { canShare, stopSharing, useLiveSharing } from "./liveTracking";

/** Just the feeding, for My day: a visit can be sent on its way from there, and the map should be fed while that screen is the one open. */
export function LiveSharingRun({ visitId }: { visitId: string | null }) {
  useLiveSharing(visitId);
  return null;
}

export function LiveSharingNote({ visitId }: { visitId: string }) {
  const session = useSession();
  const [stopped, setStopped] = useState(false);
  const [stopping, setStopping] = useState(false);
  const allowed = canShare(session);
  useLiveSharing(allowed && !stopped ? visitId : null);
  if (!allowed) return null;
  const stop = async () => {
    setStopping(true);
    try {
      await stopSharing(session.company.id, visitId);
      setStopped(true);
    } catch (error) {
      toast.error(t("Couldn't stop the sharing"), { description: errorMessage(error) });
    } finally {
      setStopping(false);
    }
  };
  return (
    <div className="callout" role="status">
      <Icon name="pin" size={16} />
      <div className="grow">
        {stopped
          ? t("You stopped sharing your live location for this trip. The client's map won't update anymore.")
          : t("You're sharing your live location with the client until this visit starts. It only sends while Crewtavo is open on this phone.")}
      </div>
      {!stopped && (
        <Button loading={stopping} onClick={() => void stop()}>
          {t("Stop sharing")}
        </Button>
      )}
    </div>
  );
}
