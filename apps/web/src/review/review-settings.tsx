import {ArrowLeft01Icon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";

import {type Project, type Session} from "@/api/client";
import {StatePanel} from "@/components/product";
import {ButtonLink} from "@/components/ui/button";
import {parseSettingsRoute, type SettingsRoute} from "./review-routes.ts";
import {ReviewTopbar} from "./review-topbar.tsx";
import {ApiKeysScreen} from "./settings-api-keys.tsx";
import {McpScreen} from "./settings-mcp.tsx";
import {MembersScreen} from "./settings-members.tsx";
import {SettingsProject, SettingsProjects} from "./settings-projects.tsx";
import {PublicLinksScreen} from "./settings-public-links.tsx";

interface ReviewSettingsProps {
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly onThemeChange: () => void;
  readonly projects: readonly Project[];
  readonly session: Session;
  readonly theme: "dawn" | "moon";
}

/** Render project and installation administration inside the canonical application. */
export function ReviewSettings({
  onProjectsChanged,
  onThemeChange,
  projects,
  session,
  theme,
}: ReviewSettingsProps) {
  const route = parseSettingsRoute(window.location.pathname);
  const principal = session.principal;
  const directHuman = principal.kind === "human"
    && principal.authorizedByPrincipalId === null;
  const canManageProjects = directHuman
    || principal.capabilities.includes("project:manage");
  const administrator = directHuman
    && principal.membershipRole === "administrator";
  const reviewHref = readReturnToReview();

  return (
    <div className="as-settings">
      <ReviewTopbar
        homeHref={reviewHref}
        onThemeChange={onThemeChange}
        principal={principal}
        settingsHref={window.location.pathname}
        theme={theme}
      />
      <div className="as-settings__layout">
        <nav aria-label="Settings" className="as-settings__nav">
          <a className="as-settings__back" href={reviewHref}>
            <HugeiconsIcon aria-hidden="true" icon={ArrowLeft01Icon} strokeWidth={1.8} />
            Back to review
          </a>
          <p>Settings</p>
          {canManageProjects ? (
            <SettingsLink active={route.kind === "projects" || route.kind === "project"} href="/review/settings/projects">
              Projects
            </SettingsLink>
          ) : null}
          <SettingsLink active={route.kind === "mcp"} href="/review/settings/mcp">
            MCP
          </SettingsLink>
          {administrator ? (
            <>
              <SettingsLink active={route.kind === "members"} href="/review/settings/members">Members</SettingsLink>
              <SettingsLink active={route.kind === "apiKeys"} href="/review/settings/api-keys">API keys</SettingsLink>
              <SettingsLink active={route.kind === "publicLinks"} href="/review/settings/public-links">Public links</SettingsLink>
            </>
          ) : null}
        </nav>
        <main className="as-settings__content" id="main-content">
          <SettingsContent
            administrator={administrator}
            canManageProjects={canManageProjects}
            onProjectsChanged={onProjectsChanged}
            projects={projects}
            route={route}
          />
        </main>
      </div>
    </div>
  );
}

function SettingsContent({
  administrator,
  canManageProjects,
  onProjectsChanged,
  projects,
  route,
}: {
  readonly administrator: boolean;
  readonly canManageProjects: boolean;
  readonly onProjectsChanged: () => Promise<readonly Project[]>;
  readonly projects: readonly Project[];
  readonly route: SettingsRoute;
}) {
  if (route.kind === "notFound") {
    return (
      <StatePanel
        action={(
          <ButtonLink href="/review/settings/projects" variant="outline">
            View settings
          </ButtonLink>
        )}
        description="This Artifact Server settings route does not exist."
        title="Page not found"
      />
    );
  }
  if (route.kind === "projects" || route.kind === "project") {
    if (!canManageProjects) return <ProjectPermissionRequired />;
    if (route.kind === "projects") {
      return (
        <SettingsProjects
          canManage={canManageProjects}
          onProjectsChanged={onProjectsChanged}
          projects={projects}
        />
      );
    }
    return (
      <SettingsProject
        canManage={canManageProjects}
        onProjectsChanged={onProjectsChanged}
        projectId={route.projectId}
        projects={projects}
      />
    );
  }
  if (route.kind === "mcp") return <McpScreen administrator={administrator} />;
  if (!administrator) return <AdministratorPermissionRequired />;
  switch (route.kind) {
    case "members":
      return <MembersScreen />;
    case "apiKeys":
      return <ApiKeysScreen />;
    case "publicLinks":
      return <PublicLinksScreen />;
  }
  return <AdministratorPermissionRequired />;
}

function SettingsLink({
  active,
  children,
  href,
}: {
  readonly active: boolean;
  readonly children: React.ReactNode;
  readonly href: string;
}) {
  return (
    <a aria-current={active ? "page" : undefined} data-active={active} href={href}>
      {children}
    </a>
  );
}

function ProjectPermissionRequired() {
  return (
    <StatePanel
      description="This account cannot manage projects."
      title="Project permission required"
    />
  );
}

function AdministratorPermissionRequired() {
  return (
    <StatePanel
      description="Only an installation administrator can manage members, API keys, and public links."
      title="Administrator permission required"
    />
  );
}

function readReturnToReview(): string {
  const stored = window.sessionStorage.getItem("artifact-review-return-url");
  return stored?.startsWith("/review") && !stored.startsWith("/review/settings")
    ? stored
    : "/review";
}
