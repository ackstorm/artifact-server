import {ArrowUp01Icon, Logout03Icon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";
import {Popover} from "@base-ui/react/popover";

import {api, type Principal} from "@/api/client";

import {initials} from "./principal-chip.tsx";

/** The signed-in account at the foot of the catalog; it opens Sign out. */
export function ReviewAccountMenu({principal}: {readonly principal: Principal}) {
  const name = principal.displayName ?? "Signed in";
  const role = principal.authorizedByPrincipalId === null
    ? principal.membershipRole === "administrator" ? "Administrator" : "Member"
    : "API key";

  return (
    <Popover.Root>
      <Popover.Trigger
        render={(
          <button
            aria-label={`Account: ${name}`}
            className="as-account"
            title={name}
            type="button"
          />
        )}
      >
        <span aria-hidden="true" className="as-account__avatar">{initials(name) || "?"}</span>
        <span className="as-account__identity">
          <strong>{name}</strong>
          <span>{role}</span>
        </span>
        <HugeiconsIcon aria-hidden="true" className="as-account__chevron" icon={ArrowUp01Icon} strokeWidth={1.8} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" className="as-share-positioner" side="top" sideOffset={8}>
          <Popover.Popup className="as-account__menu">
            <button
              className="as-account__menu-item"
              onClick={() => void api.logout().finally(() => window.location.assign("/review"))}
              type="button"
            >
              <HugeiconsIcon icon={Logout03Icon} strokeWidth={1.8} />
              Sign out
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
