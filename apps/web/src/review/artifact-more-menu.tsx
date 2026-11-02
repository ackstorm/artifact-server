import { Copy01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Popover } from "@base-ui/react/popover";
import { useRef, useState } from "react";

/**
 * The ⋯ menu next to Download. `onDuplicate` resolves to an error message, or null on success.
 * One click keeps one idempotency key until it succeeds or the menu closes, so a retry replays it.
 */
export function ArtifactMoreMenu({
  disabled,
  onDuplicate,
}: {
  readonly disabled: boolean;
  readonly onDuplicate: (idempotencyKey: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  const duplicate = async (): Promise<void> => {
    setPending(true);
    setFailure(null);
    idempotencyKey.current ??= crypto.randomUUID();
    const message = await onDuplicate(idempotencyKey.current);
    setPending(false);
    if (message === null) {
      idempotencyKey.current = null;
      setOpen(false);
    } else setFailure(message);
  };

  return (
    <Popover.Root
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) {
          setFailure(null);
          idempotencyKey.current = null;
        }
      }}
      open={open}
    >
      <Popover.Trigger
        render={(
          <button
            aria-label="More actions"
            className="as-icon-button"
            disabled={disabled}
            title="More actions"
            type="button"
          />
        )}
      >
        <HugeiconsIcon aria-hidden="true" icon={MoreHorizontalIcon} strokeWidth={1.8} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" className="as-share-positioner" sideOffset={8}>
          <Popover.Popup aria-label="More actions" className="as-more-menu">
            <button
              aria-busy={pending}
              className="as-more-menu__item"
              disabled={pending}
              onClick={() => void duplicate()}
              type="button"
            >
              <HugeiconsIcon aria-hidden="true" icon={Copy01Icon} strokeWidth={1.8} />
              <span>
                <strong>Duplicate</strong>
                <small>A Private copy of the current version, owned by you, with its own history.</small>
              </span>
            </button>
            {failure === null
              ? null
              : <p className="as-share-message" data-tone="error" role="alert">{failure}</p>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
