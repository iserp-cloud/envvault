import { useState } from "react";
import { Check, Copy, Download, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

type Props = {
  recoveryKey: string;
  username: string;
  /** Heading override, e.g. when regenerating. */
  title?: string;
  actionLabel?: string;
  onDone: () => void;
};

/** One-time display of the recovery key. The user must confirm they've saved it. */
export function RecoveryKeyPanel({
  recoveryKey,
  username,
  title = "Save your recovery key",
  actionLabel = "Continue",
  onDone,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the key is selectable on screen */
    }
  }

  function download() {
    const blob = new Blob(
      [
        `EnvVault recovery key for ${username}\n\n${recoveryKey}\n\n` +
          "Keep this somewhere safe and private. Anyone with it can reset your password " +
          "and read your secrets. EnvVault cannot recover it for you.\n",
      ],
      { type: "text/plain" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `envvault-recovery-${username}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div>
      <div className="grid size-10 place-items-center rounded-lg bg-accent text-accent-foreground">
        <KeyRound className="size-5" />
      </div>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        If you forget your password, this key is the <strong>only</strong> way back in — the server
        can&apos;t reset it for you. It is shown once.
      </p>

      <div
        className="mt-6 select-all break-words rounded-lg border bg-muted/50 p-4 text-center font-mono text-[15px] leading-7 tracking-wide"
        data-testid="recovery-key"
      >
        {recoveryKey}
      </div>

      <div className="mt-3 flex gap-2">
        <Button type="button" variant="outline" className="flex-1" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" variant="outline" className="flex-1" onClick={download}>
          <Download />
          Download
        </Button>
      </div>

      <label className="mt-6 flex cursor-pointer items-start gap-2.5 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={saved}
          onCheckedChange={(on) => setSaved(on === true)}
        />
        <span>I&apos;ve stored this key somewhere safe (a password manager is ideal).</span>
      </label>

      <Button className="mt-5 h-10 w-full" disabled={!saved} onClick={onDone}>
        {actionLabel}
      </Button>
    </div>
  );
}
