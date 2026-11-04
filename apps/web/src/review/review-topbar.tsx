import {Logout03Icon, Moon02Icon, Settings02Icon, Sun03Icon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";
import {Popover} from "@base-ui/react/popover";
import type {MouseEvent as ReactMouseEvent} from "react";

import {api, type Principal} from "@/api/client";

import {ArtifactMark} from "./artifact-mark.tsx";
import {initials} from "./principal-chip.tsx";

/** The application bar: brand on the left; theme, settings and account on the right. */
export function ReviewTopbar({
  homeHref,
  onHome,
  onThemeChange,
  principal,
  settingsHref,
  theme,
}: {
  readonly homeHref: string;
  readonly onHome?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  readonly onThemeChange: () => void;
  readonly principal: Principal;
  readonly settingsHref: string;
  readonly theme: "dawn" | "moon";
}) {
  const name = principal.displayName ?? "Signed in";
  const role = principal.authorizedByPrincipalId === null
    ? principal.membershipRole === "administrator" ? "Administrator" : "Member"
    : "API key";
  const themeLabel = theme === "moon" ? "Use light theme" : "Use dark theme";

  return (
    <header className="as-topbar">
      <a
        aria-label="Artifact Server"
        className="as-topbar__brand"
        href={homeHref}
        onClick={onHome}
        title="Artifact Server"
      >
        <span className="as-topbar__mark"><ArtifactMark /></span>
        <span aria-hidden="true" className="as-topbar__name">Artifact Server</span>
      </a>
      <div className="as-topbar__actions">
        <button
          aria-label={themeLabel}
          className="as-icon-button"
          onClick={onThemeChange}
          title={themeLabel}
          type="button"
        >
          <HugeiconsIcon icon={theme === "moon" ? Sun03Icon : Moon02Icon} strokeWidth={1.8} />
        </button>
        <a aria-label="Open settings" className="as-icon-button" href={settingsHref} title="Open settings">
          <HugeiconsIcon icon={Settings02Icon} strokeWidth={1.8} />
        </a>
        <Popover.Root>
          <Popover.Trigger
            render={(
              <button
                aria-label={`Account: ${name}`}
                className="as-topbar__avatar"
                title={name}
                type="button"
              />
            )}
          >
            {initials(name) || "?"}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner align="end" className="as-share-positioner" sideOffset={8}>
              <Popover.Popup className="as-topbar__menu">
                <div className="as-topbar__identity">
                  <strong>{name}</strong>
                  <span>{role}</span>
                </div>
                <button
                  className="as-topbar__menu-item"
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
      </div>
    </header>
  );
}
