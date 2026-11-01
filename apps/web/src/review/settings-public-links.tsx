import {useEffect, useMemo, useRef, useState} from "react";
import {flushSync} from "react-dom";

import {
  api,
  type MakePublicLinkPrivateItem,
  type PublicLinkItem,
  type PublicLinkMutationResult,
  type PublicLinkPage,
  type PublicLinkPolicy,
} from "@/api/client";
import {ErrorPanel, PageHeader, StatePanel, StatusBadge} from "@/components/product";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {Button, ButtonLink} from "@/components/ui/button";
import {Checkbox} from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {formatTimestamp} from "@/lib/presentation";

const maximumBulkSize = 100;

type FailedMutationResult = Extract<
  PublicLinkMutationResult,
  {readonly status: "failed"}
>;

interface FailedMutation {
  readonly command: MakePublicLinkPrivateItem;
  readonly item: PublicLinkItem;
  readonly result: FailedMutationResult;
}

/** Administrator-only public-link switch, cross-project inventory and shutdown surface. */
export function PublicLinksScreen({
  organizationName,
}: {
  readonly organizationName: string | null;
}) {
  const [pages, setPages] = useState<readonly PublicLinkPage[]>([]);
  const [policy, setPolicy] = useState<PublicLinkPolicy | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [confirmation, setConfirmation] = useState<readonly PublicLinkItem[]>([]);
  const [failures, setFailures] = useState<readonly FailedMutation[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);

  const loadedItems = useMemo(
    () => pages.flatMap((page) => page.publicLinks),
    [pages],
  );
  const currentPage = pages[pageIndex] ?? null;
  const visibleItems = currentPage?.publicLinks ?? [];
  const selectedItems = loadedItems.filter((item) =>
    selectedKeys.has(selectionKey(item))
  );
  const fullyLoaded = pages.length > 0 && pages.at(-1)?.nextCursor === null;
  const allVisibleSelected = visibleItems.length > 0 && visibleItems.every((item) =>
    selectedKeys.has(selectionKey(item))
  );

  const loadFirstPage = async () => {
    setLoading(true);
    setError(null);
    try {
      const [firstPage, loadedPolicy] = await Promise.all([
        api.publicLinks(null),
        api.publicLinkPolicy(),
      ]);
      setPages([firstPage]);
      setPolicy(loadedPolicy);
      setPageIndex(0);
      setSelectedKeys(new Set());
      setFailures([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Public-link inventory failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadFirstPage();
  }, []);

  const showNextPage = async () => {
    const cached = pages[pageIndex + 1];
    if (cached !== undefined) {
      setPageIndex((current) => current + 1);
      return;
    }
    if (currentPage?.nextCursor === null || currentPage === null) return;
    setLoading(true);
    setError(null);
    try {
      const nextPage = await api.publicLinks(currentPage.nextCursor);
      setPages((current) => [...current, nextPage]);
      setPageIndex((current) => current + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Public-link page failed."));
    } finally {
      setLoading(false);
    }
  };

  const selectItems = (items: readonly PublicLinkItem[], checked: boolean) => {
    setSelectionMessage(null);
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const item of items) {
        const key = selectionKey(item);
        if (!checked) {
          next.delete(key);
          continue;
        }
        if (next.size >= maximumBulkSize && !next.has(key)) {
          setSelectionMessage(
            `Bulk changes are limited to ${maximumBulkSize} public links. Clear part of the selection before adding more.`,
          );
          break;
        }
        next.add(key);
      }
      return next;
    });
  };

  const removeItems = (keys: ReadonlySet<string>) => {
    setPages((current) => current.map((page) => ({
      ...page,
      publicLinks: page.publicLinks.filter((item) => !keys.has(selectionKey(item))),
    })));
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of keys) next.delete(key);
      return next;
    });
  };

  const executeMutation = async (
    items: readonly PublicLinkItem[],
    commands: readonly MakePublicLinkPrivateItem[],
    retainedFailures: readonly FailedMutation[] = [],
  ) => {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.makePublicLinksPrivate(commands);
      const itemByKey = new Map(items.map((item) => [selectionKey(item), item]));
      const commandByKey = new Map(commands.map((command) => [commandKey(command), command]));
      const succeeded = new Set<string>();
      const nextFailures: FailedMutation[] = [...retainedFailures];
      for (const result of response.results) {
        const key = resultKey(result);
        if (result.status === "made_private") {
          succeeded.add(key);
          continue;
        }
        const item = itemByKey.get(key);
        const command = commandByKey.get(key);
        if (item === undefined || command === undefined) {
          throw new Error("A public-link mutation result did not match its bounded request.");
        }
        nextFailures.push({command, item, result});
      }
      removeItems(succeeded);
      setFailures(nextFailures);
      setSelectedKeys(new Set(nextFailures.map(({item}) => selectionKey(item))));
      if (response.summary.succeeded > 0) {
        setNotice(
          `${response.summary.succeeded} ${response.summary.succeeded === 1 ? "link is" : "links are"} no longer public. ${response.warning}`,
        );
        setPolicy(await api.publicLinkPolicy());
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Stopping public access failed."));
    } finally {
      setPending(false);
    }
  };

  const confirmMutation = async () => {
    const items = confirmation;
    setConfirmation([]);
    await executeMutation(items, items.map(makePrivateCommand));
  };

  const retryFailures = async () => {
    const retained = failures.filter(({result}) =>
      result.retry === "not_retryable"
    );
    const retryable = failures.filter(({result}) =>
      result.retry !== "not_retryable"
    );
    setPending(true);
    setError(null);
    try {
      const prepared = await Promise.all(retryable.map(async (failure) => {
        if (failure.result.retry === "same_command") return failure;
        const details = await api.artifact(
          failure.item.project.id,
          failure.item.artifact.id,
        );
        if (details.artifact.accessSetting !== "public_link") {
          return {alreadyPrivate: failure.item} as const;
        }
        return {
          command: {
            ...failure.command,
            expectedCurrentVersionId: details.artifact.currentVersionId,
            idempotencyKey: crypto.randomUUID(),
          },
          item: {
            ...failure.item,
            artifact: details.artifact,
            currentVersion: details.current.version,
          },
        } as const;
      }));
      const alreadyPrivate = new Set(prepared.flatMap((entry) =>
        "alreadyPrivate" in entry ? [selectionKey(entry.alreadyPrivate)] : []
      ));
      removeItems(alreadyPrivate);
      const ready = prepared.flatMap((entry) =>
        "alreadyPrivate" in entry ? [] : [entry]
      );
      if (ready.length === 0) {
        setFailures(retained);
        if (alreadyPrivate.size > 0) {
          setNotice("The remaining links were already not public when their current state was refreshed.");
        }
        return;
      }
      await executeMutation(
        ready.map(({item}) => item),
        ready.map(({command}) => command),
        retained,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Retrying public links failed."));
    } finally {
      setPending(false);
    }
  };

  if (loading && pages.length === 0) {
    return (
      <StatePanel
        description="Loading active public links across every project."
        title="Loading public links"
      />
    );
  }
  if (error !== null && pages.length === 0) {
    return <ErrorPanel error={error} onRetry={() => void loadFirstPage()} />;
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        actions={(
          <Button onClick={() => void loadFirstPage()} type="button" variant="outline">
            Reload
          </Button>
        )}
        description="See every active artifact that currently allows public-link access, then stop public access for individual links or a bounded selection."
        eyebrow="Administration"
        title="Public links"
      />

      {policy === null ? null : (
        <PublicLinkSwitch
          onChanged={setPolicy}
          organization={organizationName ?? "this Artifact Server"}
          policy={policy}
        />
      )}

      {error === null ? null : <ErrorPanel error={error} onRetry={() => void loadFirstPage()} />}
      {notice === null ? null : (
        <Alert>
          <AlertTitle>Public access changed</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {failures.length === 0 ? null : (
        <Alert variant="destructive">
          <AlertTitle>
            {failures.length} {failures.length === 1 ? "link was" : "links were"} not changed
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-left text-sm">
              {failures.map(({item, result}) => (
                <li key={selectionKey(item)}>
                  {item.project.name} / {item.artifact.name}: {result.error.message}
                </li>
              ))}
            </ul>
            {failures.some(({result}) => result.retry !== "not_retryable")
              ? (
                <Button
                  className="mt-3"
                  disabled={pending}
                  onClick={() => void retryFailures()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {pending ? "Retrying…" : "Retry failed"}
                </Button>
              )
              : null}
          </AlertDescription>
        </Alert>
      )}

      {loadedItems.length === 0 && fullyLoaded
        ? (
          <StatePanel
            description="No active artifact in this installation currently allows public-link access."
            title="No public links"
          />
        )
        : (
          <>
            {policy?.publicLinksEnabled === false
              ? (
                <Alert>
                  <AlertDescription>
                    Public links are off. These artifacts keep their Public setting but do not
                    open without sign-in. Stop public access lowers them to Organization.
                  </AlertDescription>
                </Alert>
              )
              : null}
            <section
              aria-label="Bulk selection"
              className="flex flex-col gap-3 border p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={visibleItems.length === 0}
                  onClick={() => selectItems(visibleItems, true)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Select visible ({visibleItems.length})
                </Button>
                <Button
                  disabled={loadedItems.length === 0 || loadedItems.length > maximumBulkSize}
                  onClick={() => selectItems(loadedItems, true)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {fullyLoaded ? "Select all" : "Select all loaded"} ({loadedItems.length})
                </Button>
                <Button
                  disabled={selectedKeys.size === 0}
                  onClick={() => setSelectedKeys(new Set())}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Clear selection
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-muted-foreground">
                  {selectedItems.length} selected · maximum {maximumBulkSize}
                </span>
                <Button
                  disabled={pending || selectedItems.length === 0}
                  onClick={() => setConfirmation(selectedItems)}
                  size="sm"
                  type="button"
                >
                  Stop public access ({selectedItems.length})
                </Button>
              </div>
              <p className="basis-full text-xs leading-5 text-muted-foreground sm:order-3">
                {fullyLoaded
                  ? "All inventory pages are loaded, so Select all covers every listed public link."
                  : "More inventory pages exist. Select all loaded never includes pages you have not visited."}
                {loadedItems.length > maximumBulkSize
                  ? ` Select visible or choose up to ${maximumBulkSize} links for one bulk change.`
                  : ""}
              </p>
              {selectionMessage === null ? null : (
                <p className="basis-full text-sm text-destructive sm:order-4" role="alert">
                  {selectionMessage}
                </p>
              )}
            </section>

            <div className="as-public-links-inventory">
              <table aria-label="Public links inventory" className="as-public-links-table">
                <colgroup>
                  <col className="as-public-links-table__select-column" />
                  <col className="as-public-links-table__artifact-column" />
                  <col className="as-public-links-table__link-column" />
                  <col className="as-public-links-table__actions-column" />
                </colgroup>
                <thead className="border-b bg-muted/50 text-xs tracking-widest text-muted-foreground uppercase">
                  <tr>
                    <th className="as-public-links-table__select-cell font-semibold">
                      <Checkbox
                        aria-label="Select all visible public links"
                        checked={allVisibleSelected}
                        onCheckedChange={(checked) => selectItems(visibleItems, checked)}
                      />
                    </th>
                    <th className="font-semibold">Artifact</th>
                    <th className="font-semibold">Public link</th>
                    <th className="text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.length === 0
                    ? (
                      <tr className="as-public-links-table__empty-row">
                        <td className="text-center text-muted-foreground" colSpan={4}>
                          {currentPage?.nextCursor === null
                            ? "Every link on this page is no longer public. Return to a previous page to inspect the remaining loaded links."
                            : "Every link on this loaded page is no longer public. Continue to the next page to inspect older public links."}
                        </td>
                      </tr>
                    )
                    : visibleItems.map((item) => {
                    const selected = selectedKeys.has(selectionKey(item));
                    return (
                      <tr className="as-public-links-table__row" key={selectionKey(item)}>
                        <td className="as-public-links-table__select-cell">
                          <Checkbox
                            aria-label={`Select ${item.artifact.name}`}
                            checked={selected}
                            onCheckedChange={(checked) => selectItems([item], checked)}
                          />
                        </td>
                        <td className="as-public-links-table__artifact-cell">
                          <div className="as-public-links-table__artifact-heading">
                            <a
                              className="as-public-links-table__artifact-link"
                              href={`/review?${new URLSearchParams({
                                artifact: item.artifact.id,
                                project: item.project.id,
                              })}`}
                            >
                              {item.artifact.name}
                            </a>
                            {item.project.archivedAt === null
                              ? null
                              : <StatusBadge>Archived</StatusBadge>}
                          </div>
                          <p className="as-public-links-table__meta">{item.project.name}</p>
                        </td>
                        <td className="as-public-links-table__link-cell">
                          <a
                            className="as-public-links-table__url"
                            href={item.links.public}
                            rel="noreferrer"
                            target="_blank"
                            title={item.links.public}
                          >
                            {item.links.public}
                          </a>
                          <p className="as-public-links-table__meta">
                            <span>Version {item.currentVersion.number}</span>
                            <span aria-hidden="true"> · </span>
                            <span>Saved {formatTimestamp(item.currentVersion.createdAt)}</span>
                          </p>
                        </td>
                        <td className="as-public-links-table__actions-cell">
                          <div className="as-public-links-table__actions">
                            <ButtonLink
                              href={item.links.public}
                              rel="noreferrer"
                              size="xs"
                              target="_blank"
                              variant="outline"
                            >
                              Open
                            </ButtonLink>
                            <Button
                              disabled={pending}
                              onClick={() => setConfirmation([item])}
                              size="xs"
                              type="button"
                              variant="ghost"
                            >
                              Stop public access
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                    })}
                </tbody>
              </table>
            </div>

            <nav aria-label="Public links pagination" className="flex items-center justify-between">
              <Button
                disabled={loading || pageIndex === 0}
                onClick={() => setPageIndex((current) => current - 1)}
                type="button"
                variant="outline"
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">Page {pageIndex + 1}</span>
              <Button
                disabled={loading || currentPage?.nextCursor === null}
                onClick={() => void showNextPage()}
                type="button"
                variant="outline"
              >
                {loading ? "Loading…" : "Next"}
              </Button>
            </nav>
          </>
        )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmation([]);
        }}
        open={confirmation.length > 0}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Stop public access for {confirmation.length} {confirmation.length === 1 ? "link" : "links"}?
            </DialogTitle>
            <DialogDescription>
              New requests to successful items will require an admitted account. Copies already
              downloaded or cached outside Artifact Server cannot be recalled.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm leading-6 text-muted-foreground">
            Each item is checked against the current version shown when you selected it. If an
            artifact changed, that item fails without changing its access and can be retried after
            refreshing its version.
          </p>
          <DialogFooter>
            <Button
              disabled={pending}
              onClick={() => setConfirmation([])}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() => void confirmMutation()}
              type="button"
            >
              {pending ? "Stopping public access…" : "Stop public access"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Turns public links off or on for the installation, confirming in place. */
function PublicLinkSwitch({
  onChanged,
  organization,
  policy,
}: {
  readonly onChanged: (policy: PublicLinkPolicy) => void;
  readonly organization: string;
  readonly policy: PublicLinkPolicy;
}) {
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const switchButton = useRef<HTMLButtonElement>(null);
  const enabled = policy.publicLinksEnabled;
  const action = enabled ? "Turn off public links" : "Turn on public links";

  const openConfirmation = () => {
    setPolicyError(null);
    setConfirming(true);
  };

  const closeConfirmation = () => {
    flushSync(() => setConfirming(false));
    switchButton.current?.focus();
  };

  const change = async () => {
    setSaving(true);
    setPolicyError(null);
    try {
      onChanged(await api.changePublicLinkPolicy(!enabled));
    } catch (caught) {
      setPolicyError(
        caught instanceof Error ? caught.message : "The public-link setting could not be changed.",
      );
    } finally {
      setSaving(false);
      closeConfirmation();
    }
  };

  return (
    <section aria-labelledby="as-public-link-switch-heading" className="flex flex-col gap-3 border p-4">
      <h2
        className="text-xs font-semibold tracking-widest text-muted-foreground uppercase"
        id="as-public-link-switch-heading"
      >
        Public links for this installation
      </h2>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-6" role="status">
          {enabled
            ? (
              <>
                <strong>On.</strong> Owners can make an artifact Public, so anyone with its link
                opens it without signing in.
              </>
            )
            : (
              <>
                <strong>Off.</strong> No artifact opens without sign-in, and nobody can make one
                Public.
              </>
            )}
        </p>
        {confirming ? null : (
          <Button
            disabled={policy.setByConfiguration}
            onClick={openConfirmation}
            ref={switchButton}
            size="sm"
            type="button"
            variant="outline"
          >
            {action}
          </Button>
        )}
      </div>
      {policy.setByConfiguration
        ? (
          <p className="text-sm break-words text-muted-foreground">
            Set by the server configuration. Change ARTIFACT_SERVER_PUBLIC_LINKS_ENABLED to change it.
          </p>
        )
        : null}
      {confirming
        ? (
          <div
            aria-label={enabled
              ? "Confirm turning off public links"
              : "Confirm turning on public links"}
            className="flex flex-col gap-3 border border-dashed p-4 text-sm leading-6"
            role="group"
          >
            {(enabled
              ? disableCopy(policy.publicArtifactCount, organization)
              : [enableCopy(policy.publicArtifactCount)]
            ).map((line) => <p key={line}>{line}</p>)}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                autoFocus
                disabled={saving}
                onClick={closeConfirmation}
                size="sm"
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={saving} onClick={() => void change()} size="sm" type="button">
                {saving ? "Saving…" : action}
              </Button>
            </div>
          </div>
        )
        : null}
      {policyError === null ? null : (
        <p className="text-sm text-destructive" role="alert">{policyError}</p>
      )}
    </section>
  );
}

function disableCopy(count: number, organization: string): readonly string[] {
  const reach = count === 0
    ? "No artifact is Public now."
    : count === 1
      ? `1 artifact is Public now. It stops opening without sign-in as soon as you turn public links off. It keeps its Public setting, and opens without sign-in again if you turn public links back on. Until then, people signed in to ${organization} with the link can still open it.`
      : `${count} artifacts are Public now. They stop opening without sign-in as soon as you turn public links off. They keep their Public setting, and open without sign-in again if you turn public links back on. Until then, people signed in to ${organization} with the link can still open them.`;
  return [
    reach,
    "Nobody can make an artifact Public while public links are off. Pages already open or downloaded, and copies cached outside Artifact Server, cannot be recalled.",
  ];
}

function enableCopy(count: number): string {
  return count === 0
    ? "Owners can make artifacts Public again."
    : count === 1
      ? "1 artifact keeps its Public setting and opens without sign-in again as soon as you turn public links on."
      : `${count} artifacts keep their Public setting and open without sign-in again as soon as you turn public links on.`;
}

function makePrivateCommand(item: PublicLinkItem): MakePublicLinkPrivateItem {
  return {
    artifactId: item.artifact.id,
    expectedCurrentVersionId: item.artifact.currentVersionId,
    idempotencyKey: crypto.randomUUID(),
    projectId: item.project.id,
  };
}

function selectionKey(item: PublicLinkItem): string {
  return `${item.project.id}\0${item.artifact.id}`;
}

function commandKey(command: MakePublicLinkPrivateItem): string {
  return `${command.projectId}\0${command.artifactId}`;
}

function resultKey(result: PublicLinkMutationResult): string {
  return `${result.projectId}\0${result.artifactId}`;
}
