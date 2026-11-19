import { useEffect, useState } from "react";
import { myFingerprint, type Session } from "@/api";

/** Your public-key fingerprint. Compare it out-of-band before trusting a shared key. */
export function Fingerprint({ session }: { session: Session }) {
  const [value, setValue] = useState<string>("…");
  useEffect(() => {
    let live = true;
    myFingerprint(session)
      .then((f) => live && setValue(f))
      .catch(() => live && setValue("unavailable"));
    return () => {
      live = false;
    };
  }, [session]);
  return (
    <span className="block break-words font-mono text-[11px] leading-4 text-muted-foreground">
      {value}
    </span>
  );
}
