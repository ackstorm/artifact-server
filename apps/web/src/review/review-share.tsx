import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Building06Icon,
  Cancel01Icon,
  Copy01Icon,
  File01Icon,
  Globe02Icon,
  SecurityLockIcon,
  Share01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Popover } from "@base-ui/react/popover";
import { useEffect, useRef, useState } from "react";

import {
  api,
  type AccessSetting,
  type ArtifactDetails,
  type ArtifactVersion,
} from "@/api/client";
import { accessSettingLabel } from "@/lib/presentation";
import claudeLogoUrl from "./assets/agents/claude.svg";
import codexDarkLogoUrl from "./assets/agents/codex-dark.svg";
import codexLightLogoUrl from "./assets/agents/codex-light.svg";
import copilotDarkLogoUrl from "./assets/agents/copilot-dark.svg";
import copilotLightLogoUrl from "./assets/agents/copilot-light.svg";
import cursorDarkLogoUrl from "./assets/agents/cursor-dark.svg";
import cursorLightLogoUrl from "./assets/agents/cursor-light.svg";
import opencodeDarkLogoUrl from "./assets/agents/opencode-dark.svg";
import opencodeLightLogoUrl from "./assets/agents/opencode-light.svg";
import piLogoUrl from "./assets/agents/pi.svg";
import piLightLogoUrl from "./assets/agents/pi-light.svg";

type ShareScreen = "agents" | "overview";
type CopiedTarget =
  | "agent-prompt"
  | "latest-link"
  | "local-command"
  | "mcp-address"
  | "public-link"
  | "raw-link"
  | "review-link";

const copiedResetMilliseconds = 1_600;

/** Every level, lowest first. */
const accessLevels: readonly AccessSetting[] = ["private", "account_required", "public_link"];

const accessLevelIcons = {
  account_required: Building06Icon,
  private: SecurityLockIcon,
  public_link: Globe02Icon,
} as const;

interface ReviewShareControlProps {
  /** The reader may lower the level: the owner or a human administrator. */
  readonly canLower: boolean;
  /** The reader may raise the level: the principal that controls the artifact. */
  readonly canRaise: boolean;
  readonly details: ArtifactDetails | null;
  readonly onArtifactChanged: (artifact: ArtifactDetails["artifact"]) => void;
  readonly organizationName: string | null;
  readonly selectedPath: string | null;
  readonly selectedVersion: ArtifactVersion | null;
  readonly triggerClassName: string;
}

/** Share one artifact from either the standard viewer header or focus controls. */
export function ReviewShareControl({
  canLower,
  canRaise,
  details,
  onArtifactChanged,
  organizationName,
  selectedPath,
  selectedVersion,
  triggerClassName,
}: ReviewShareControlProps) {
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<ShareScreen>("overview");
  const [chosenAccess, setChosenAccess] = useState<AccessSetting | null>(null);
  const [pending, setPending] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState<CopiedTarget | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [accessFailure, setAccessFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copiedResetTimer.current !== null) clearTimeout(copiedResetTimer.current);
  }, []);

  const updateOpen = (next: boolean): void => {
    if (pending && !next) return;
    setOpen(next);
    if (next) {
      setScreen("overview");
      setCopiedTarget(null);
      setFailure(null);
      setChosenAccess(null);
      setAccessFailure(null);
      setNotice(null);
    }
  };

  const copyText = async (
    text: string,
    target: CopiedTarget,
    failureMessage: string,
  ): Promise<void> => {
    setFailure(null);
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("Clipboard access is unavailable in this browser.");
      }
      await navigator.clipboard.writeText(text);
      setCopiedTarget(target);
      if (copiedResetTimer.current !== null) clearTimeout(copiedResetTimer.current);
      copiedResetTimer.current = setTimeout(
        () => setCopiedTarget(null),
        copiedResetMilliseconds,
      );
    } catch (caught) {
      setCopiedTarget(null);
      setFailure(
        caught instanceof Error ? caught.message : failureMessage,
      );
    }
  };

  const reviewLink = selectedVersion === null
    ? null
    : exactReviewLink(selectedVersion, selectedPath);

  const copyReviewLink = async (): Promise<void> => {
    if (reviewLink === null) return;
    await copyText(
      reviewLink,
      "review-link",
      "The exact Review link could not be copied.",
    );
  };

  const copyAgentPrompt = async (): Promise<void> => {
    if (details === null || selectedVersion === null || reviewLink === null) return;
    await copyText(
      buildAgentReviewPrompt(details, selectedVersion, reviewLink),
      "agent-prompt",
      "The agent review prompt could not be copied.",
    );
  };

  const savedAccess = details?.artifact.accessSetting ?? "private";
  const organization = organizationName ?? "this Artifact Server";
  const accessChoices = canRaise
    ? accessLevels
    : canLower
      ? accessLevels.slice(0, accessLevels.indexOf(savedAccess) + 1)
      : [savedAccess];
  const confirmingPublic = chosenAccess === "public_link" && !pending;

  const saveAccess = async (level: AccessSetting): Promise<void> => {
    if (details === null) return;
    const lowering = accessLevels.indexOf(level)
      < accessLevels.indexOf(details.artifact.accessSetting);
    setPending(true);
    try {
      const changed = await api.changeAccess(
        details.artifact.projectId,
        details.artifact.id,
        details.artifact.currentVersionId,
        level,
        crypto.randomUUID(),
      );
      onArtifactChanged(changed.artifact);
      setNotice(lowering ? changed.warning : null);
    } catch (caught) {
      setAccessFailure(
        caught instanceof Error ? caught.message : "Artifact access could not be changed.",
      );
    } finally {
      setPending(false);
      setChosenAccess(null);
    }
  };

  const chooseAccess = (level: AccessSetting): void => {
    setAccessFailure(null);
    setNotice(null);
    if (level === savedAccess) {
      setChosenAccess(null);
      return;
    }
    setChosenAccess(level);
    if (level !== "public_link") void saveAccess(level);
  };

  const publicArtifact = savedAccess === "public_link";
  const serverOrigin = details === null ? "" : new URL(details.links.artifact).origin;
  const mcpAddress = `${serverOrigin}/mcp`;

  return (
    <Popover.Root open={open} onOpenChange={updateOpen}>
      <Popover.Trigger
        render={(
          <button
            aria-label="Share"
            className={triggerClassName}
            disabled={details === null || selectedVersion === null}
            type="button"
          />
        )}
      >
        <HugeiconsIcon aria-hidden="true" icon={Share01Icon} strokeWidth={1.8} />
        <span className="as-button__label">Share</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Backdrop className="as-share-backdrop" />
        <Popover.Positioner align="end" className="as-share-positioner" sideOffset={8}>
          <Popover.Popup aria-label="Share artifact" className="as-share-popover">
            {screen === "overview" ? (
              <header className="as-share-popover__header as-share-popover__header--artifact">
                <span aria-hidden="true" className="as-share-destination__icon">
                  <HugeiconsIcon icon={File01Icon} strokeWidth={1.8} />
                </span>
                <div>
                  <h2>{details?.artifact.name ?? "Artifact"}</h2>
                  <p>Exact version · Version {selectedVersion?.version.number ?? "—"}</p>
                </div>
                <button
                  aria-label="Close Share"
                  className="as-icon-button"
                  disabled={pending}
                  onClick={() => updateOpen(false)}
                  type="button"
                >
                  <HugeiconsIcon aria-hidden="true" icon={Cancel01Icon} strokeWidth={1.8} />
                </button>
              </header>
            ) : (
              <header className="as-share-popover__header">
                <button
                  aria-label="Back to Share"
                  className="as-icon-button"
                  disabled={pending}
                  onClick={() => setScreen("overview")}
                  type="button"
                >
                  <HugeiconsIcon aria-hidden="true" icon={ArrowLeft01Icon} strokeWidth={1.8} />
                </button>
                <div>
                  <h2>Connect MCP</h2>
                  <p>{details?.artifact.name ?? "No artifact selected"}</p>
                </div>
                <button
                  aria-label="Close Share"
                  className="as-icon-button"
                  disabled={pending}
                  onClick={() => updateOpen(false)}
                  type="button"
                >
                  <HugeiconsIcon aria-hidden="true" icon={Cancel01Icon} strokeWidth={1.8} />
                </button>
              </header>
            )}

            {screen === "overview" ? (
              <div className="as-share-overview">
                <section aria-labelledby="as-share-access-heading" className="as-share-access">
                  <h3 id="as-share-access-heading">
                    <label htmlFor="as-share-access-level">General access</label>
                  </h3>
                  <div className="as-share-access__control">
                    <HugeiconsIcon
                      aria-hidden="true"
                      icon={accessLevelIcons[chosenAccess ?? savedAccess]}
                      strokeWidth={1.8}
                    />
                    <select
                      aria-busy={pending}
                      className="as-button as-button--secondary"
                      disabled={details === null || pending || accessChoices.length < 2}
                      id="as-share-access-level"
                      onChange={(event) => chooseAccess(
                        accessLevels.find((level) => level === event.currentTarget.value)
                          ?? savedAccess,
                      )}
                      value={chosenAccess ?? savedAccess}
                    >
                      {accessChoices.map((level) => (
                        <option key={level} value={level}>
                          {canRaise || canLower
                            ? accessOptionLabel(level, organization)
                            : level === "public_link" ? "Public" : `Shared with ${organization}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p>{accessDescription(chosenAccess ?? savedAccess, organization)}</p>
                  {confirmingPublic ? (
                    <div className="as-share-access__confirm" role="group" aria-label="Confirm public access">
                      <p>
                        Anyone with the link, including people outside {organization}, can open the latest version.
                      </p>
                      <div>
                        <button
                          className="as-button"
                          onClick={() => setChosenAccess(null)}
                          type="button"
                        >
                          Cancel
                        </button>
                        <button
                          className="as-button as-button--primary"
                          onClick={() => void saveAccess("public_link")}
                          type="button"
                        >
                          Confirm
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {accessFailure === null ? null : (
                    <p className="as-share-message" data-tone="error" role="alert">{accessFailure}</p>
                  )}
                  {notice === null ? null : (
                    <p className="as-share-message" data-tone="notice" role="status">{notice}</p>
                  )}
                </section>

                {publicArtifact && details !== null ? (
                  <section aria-labelledby="as-share-public-heading" className="as-share-link">
                    <h3 id="as-share-public-heading">Public link</h3>
                    <div>
                      <code title={details.links.artifact}>{details.links.artifact}</code>
                      <button
                        className="as-button as-button--primary"
                        onClick={() => void copyText(
                          details.links.artifact,
                          "public-link",
                          "The public link could not be copied.",
                        )}
                        type="button"
                      >
                        <HugeiconsIcon
                          aria-hidden="true"
                          icon={copiedTarget === "public-link" ? Tick02Icon : Copy01Icon}
                          strokeWidth={1.8}
                        />
                        {copiedTarget === "public-link" ? "Copied" : "Copy Public link"}
                      </button>
                    </div>
                    <p>Opens the latest version without signing in.</p>
                  </section>
                ) : null}

                <section aria-labelledby="as-share-link-heading" className="as-share-link">
                  <h3 id="as-share-link-heading">Review and comment</h3>
                  <div>
                    <code title={reviewLink ?? undefined}>{reviewLink ?? ""}</code>
                    <button
                      className="as-button as-button--primary"
                      disabled={reviewLink === null}
                      onClick={() => void copyReviewLink()}
                      type="button"
                    >
                      <HugeiconsIcon
                        aria-hidden="true"
                        icon={copiedTarget === "review-link" ? Tick02Icon : Copy01Icon}
                        strokeWidth={1.8}
                      />
                      {copiedTarget === "review-link" ? "Copied" : "Copy Review link"}
                    </button>
                  </div>
                  <p>{reviewLinkNote(savedAccess, organization)}</p>
                </section>

                <section aria-labelledby="as-share-secondary-heading" className="as-share-secondary">
                  <h3 id="as-share-secondary-heading">Other links</h3>
                  <ShareSecondaryLink
                    copied={copiedTarget === "latest-link"}
                    description="Moves when a new version is published"
                    label="Latest"
                    onCopy={() => {
                      if (details !== null) {
                        void copyText(
                          details.links.artifact,
                          "latest-link",
                          "The latest artifact link could not be copied.",
                        );
                      }
                    }}
                    value={details?.links.artifact ?? ""}
                  />
                  <ShareSecondaryLink
                    copied={copiedTarget === "raw-link"}
                    description="Exact version without Review controls"
                    label="Raw"
                    onCopy={() => {
                      if (selectedVersion !== null) {
                        void copyText(
                          selectedVersion.links.version,
                          "raw-link",
                          "The raw version link could not be copied.",
                        );
                      }
                    }}
                    value={selectedVersion?.links.version ?? ""}
                  />
                </section>

                <section aria-labelledby="as-share-agent-heading" className="as-share-agent">
                  <h3 id="as-share-agent-heading">Review with an AI agent</h3>
                  <p>Copy one complete prompt into Claude, Codex, Cursor, GitHub Copilot, Pi, or OpenCode.</p>
                  <div className="as-share-agent__actions">
                    <button
                      className="as-share-agent__prompt"
                      disabled={details === null || selectedVersion === null}
                      onClick={() => void copyAgentPrompt()}
                      type="button"
                    >
                      <AgentLogos />
                      <span>
                        {copiedTarget === "agent-prompt" ? "Prompt copied" : "Copy review prompt"}
                      </span>
                      <HugeiconsIcon
                        aria-hidden="true"
                        icon={copiedTarget === "agent-prompt" ? Tick02Icon : Copy01Icon}
                        strokeWidth={1.8}
                      />
                    </button>
                    <button
                      className="as-share-agent__setup"
                      disabled={details === null}
                      onClick={() => {
                        setFailure(null);
                        setScreen("agents");
                      }}
                      type="button"
                    >
                      Connect MCP
                      <HugeiconsIcon aria-hidden="true" icon={ArrowRight01Icon} strokeWidth={1.8} />
                    </button>
                  </div>
                </section>

                {failure === null ? null : (
                  <p className="as-share-message" data-tone="error" role="alert">{failure}</p>
                )}
              </div>
            ) : (
              <div className="as-share-agent-setup">
                <p>Choose the connection that matches where Artifact Server is running.</p>

                <section>
                  <header>
                    <strong>On this computer</strong>
                    <span>Recommended for local use</span>
                  </header>
                  <p>Detect a supported client, install its private MCP connection, and verify it without copying a token.</p>
                  <CopyableAgentValue
                    copied={copiedTarget === "local-command"}
                    label="Copy local connection command"
                    onCopy={() => void copyText(
                      "artifactserver connect",
                      "local-command",
                      "The local connection command could not be copied.",
                    )}
                    value="artifactserver connect"
                  />
                </section>

                <section>
                  <header>
                    <strong>Team or remote server</strong>
                    <span>MCP</span>
                  </header>
                  <p>Add this server address to the agent. Compatible deployments open browser sign-in; other self-hosted deployments use an administrator-issued scoped key.</p>
                  <CopyableAgentValue
                    copied={copiedTarget === "mcp-address"}
                    label="Copy MCP server address"
                    onCopy={() => void copyText(
                      mcpAddress,
                      "mcp-address",
                      "The MCP server address could not be copied.",
                    )}
                    value={mcpAddress}
                  />
                </section>

                <section>
                  <header>
                    <strong>Without MCP</strong>
                    <span>HTTP API</span>
                  </header>
                  <p>The review prompt includes an exact authenticated API request for this version. Use a scoped API key from an administrator and never paste it into chat.</p>
                </section>

                {failure === null ? null : (
                  <p className="as-share-message" data-tone="error" role="alert">{failure}</p>
                )}
              </div>
            )}

            {screen === "overview" ? (
              <footer className="as-share-popover__footer">
                This Review link stays pinned to Version {selectedVersion?.version.number ?? "—"}
                {selectedPath === null ? "." : ` and ${selectedPath}.`}
              </footer>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function AgentLogos() {
  return (
    <span
      aria-label="Claude, Codex, Cursor, GitHub Copilot, Pi, and OpenCode"
      className="as-agent-logos"
      role="img"
    >
      <span aria-hidden="true" className="as-agent-logo">
        <img alt="" src={claudeLogoUrl} />
      </span>
      <ThemedAgentLogo
        darkUrl={codexDarkLogoUrl}
        lightUrl={codexLightLogoUrl}
      />
      <ThemedAgentLogo
        darkUrl={cursorDarkLogoUrl}
        lightUrl={cursorLightLogoUrl}
      />
      <ThemedAgentLogo
        darkUrl={copilotDarkLogoUrl}
        lightUrl={copilotLightLogoUrl}
      />
      <ThemedAgentLogo darkUrl={piLogoUrl} lightUrl={piLightLogoUrl} />
      <ThemedAgentLogo
        darkUrl={opencodeDarkLogoUrl}
        lightUrl={opencodeLightLogoUrl}
      />
    </span>
  );
}

function ThemedAgentLogo({
  darkUrl,
  lightUrl,
}: {
  readonly darkUrl: string;
  readonly lightUrl: string;
}) {
  return (
    <span aria-hidden="true" className="as-agent-logo">
      <img alt="" data-agent-theme="dark" src={darkUrl} />
      <img alt="" data-agent-theme="light" src={lightUrl} />
    </span>
  );
}

function CopyableAgentValue({
  copied,
  label,
  onCopy,
  value,
}: {
  readonly copied: boolean;
  readonly label: string;
  readonly onCopy: () => void;
  readonly value: string;
}) {
  return (
    <div className="as-share-agent-value">
      <code title={value}>{value}</code>
      <button aria-label={label} onClick={onCopy} type="button">
        <HugeiconsIcon
          aria-hidden="true"
          icon={copied ? Tick02Icon : Copy01Icon}
          strokeWidth={1.8}
        />
      </button>
    </div>
  );
}

function ShareSecondaryLink({
  copied,
  description,
  label,
  onCopy,
  value,
}: {
  readonly copied: boolean;
  readonly description: string;
  readonly label: string;
  readonly onCopy: () => void;
  readonly value: string;
}) {
  return (
    <div className="as-share-secondary__row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <code title={value}>{value}</code>
      <button
        aria-label={`Copy ${label.toLocaleLowerCase("en-US")} link`}
        className="as-icon-button"
        disabled={value === ""}
        onClick={onCopy}
        type="button"
      >
        <HugeiconsIcon
          aria-hidden="true"
          icon={copied ? Tick02Icon : Copy01Icon}
          strokeWidth={1.8}
        />
      </button>
    </div>
  );
}

function exactReviewLink(
  selectedVersion: ArtifactVersion,
  selectedPath: string | null,
): string {
  const reviewUrl = new URL(selectedVersion.links.review);
  reviewUrl.searchParams.set("view", "focus");
  if (
    selectedPath !== null
    && selectedVersion.manifest.entries.some((entry) => entry.path === selectedPath)
  ) {
    reviewUrl.searchParams.set("path", selectedPath);
  } else {
    reviewUrl.searchParams.delete("path");
  }
  return reviewUrl.toString();
}

function buildAgentReviewPrompt(
  details: ArtifactDetails,
  selectedVersion: ArtifactVersion,
  reviewLink: string,
): string {
  const serverOrigin = new URL(details.links.artifact).origin;
  const apiUrl = new URL(
    `/api/v1/artifacts/${encodeURIComponent(details.artifact.id)}/versions/${encodeURIComponent(selectedVersion.version.id)}`,
    serverOrigin,
  );
  apiUrl.searchParams.set("projectId", details.artifact.projectId);
  const manifestResource = `artifact://projects/${details.artifact.projectId}/artifacts/${details.artifact.id}/versions/${selectedVersion.version.id}/manifest`;

  return `Review this Artifact Server artifact. Inspect the exact saved version below and do not silently substitute a newer version.

Artifact: ${details.artifact.name}
Project ID: ${details.artifact.projectId}
Artifact ID: ${details.artifact.id}
Version: ${selectedVersion.version.number}
Version ID: ${selectedVersion.version.id}
Access: ${accessSettingLabel(details.artifact.accessSetting)}
Review and comment: ${reviewLink}
Raw exact version: ${selectedVersion.links.version}
Moving latest link: ${details.links.artifact}

Preferred path — Artifact Server MCP:
1. Call artifact_get with projectId "${details.artifact.projectId}" and artifactId "${details.artifact.id}".
2. Keep versionId "${selectedVersion.version.id}" pinned. If artifact_get reports a different current version, use artifact_version_list and review the pinned version instead.
3. Read the exact manifest resource when available: ${manifestResource}
4. Use artifact_open.reviewUrl for the full-screen Review experience. Use artifact_open.browserUrl only when you need the raw rendered artifact.
5. Review the artifact and report findings in priority order. When comment tools are available, use comment_create against this exact version for precise, actionable findings.

If Artifact Server MCP is not connected:
- Local setup: run artifactserver connect, then retry with MCP.
- Remote or team setup: add ${serverOrigin}/mcp to the agent and complete browser sign-in, or use an administrator-issued scoped key when OAuth is unavailable.
- Direct HTTP fallback: GET ${apiUrl.toString()} with an admitted session or scoped API key.
- curl example: curl --fail-with-body --header "Authorization: Bearer $ARTIFACT_SERVER_API_KEY" '${apiUrl.toString()}'

Never paste credentials into chat, source files, or the review. If access fails, state which connection or permission is missing.`;
}

function accessOptionLabel(level: AccessSetting, organization: string): string {
  return {
    account_required: `Organization — Anyone signed in to ${organization} with the link`,
    private: "Private — Only you",
    public_link: "Public — Anyone with the link, no sign-in",
  }[level];
}

function accessDescription(level: AccessSetting, organization: string): string {
  return {
    account_required: `Anyone signed in to ${organization} with the link can open it.`,
    private: "Only you can open it.",
    public_link: "Anyone with the link can open the latest version, no sign-in.",
  }[level];
}

function reviewLinkNote(level: AccessSetting, organization: string): string {
  return {
    account_required: `Anyone signed in to ${organization} can open this link.`,
    private: "Only you can open this link.",
    public_link: "For signed-in members.",
  }[level];
}
