/**
 * Apps (App-Directory.dc.html; on a phone, Mobile-Apps.dc.html): every app Crewtavo works with, in
 * its category, three across on hairline rows, each with its icon, name, one line on what it does and
 * whether it's installed. Filters for the installed ones and the ones that need attention, and a
 * search. Opening one shows its own page (AppDetailPage) to install and manage it.
 */
import { useMemo } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { InboxGroup, InboxList } from "@/components/ui/InboxList";
import { PageHeader } from "@/components/ui/PageHeader";
import { InboxSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { FilterTabs, SearchField, Toolbar } from "@/components/ui/Toolbar";
import { AppListRow, appState } from "./AppIcon";
import { CATEGORY_LABELS, infoFor, useApps, type AppRow } from "./catalog";
import { useIsInstalled } from "./installed";

type Show = "all" | "installed" | "attention";
const SHOWS: Show[] = ["all", "installed", "attention"];

/** Whether an app matches what was typed: its name, what it does, its category, or who makes it. */
export function appMatches(app: AppRow, term: string): boolean {
  const q = term.trim().toLowerCase();
  if (!q) return true;
  const info = infoFor(app);
  return [app.name, info.tagline, app.description, CATEGORY_LABELS[app.category], info.developer].some((s) => s?.toLowerCase().includes(q));
}

export function AppsPage() {
  const apps = useApps();
  const { isInstalled } = useIsInstalled();
  const [params, setParams] = useSearchParams();
  const shown = params.get("show");
  const show: Show = SHOWS.includes(shown as Show) ? (shown as Show) : "all";
  const term = params.get("q") ?? "";
  // Kept in the address, so coming back from an app's page finds the list as it was left.
  const set = (key: "show" | "q", value: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (!value || (key === "show" && value === "all")) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  const all = apps.data?.apps;
  const counts = useMemo(() => {
    const list = all ?? [];
    return {
      all: list.length,
      installed: list.filter((a) => isInstalled(a)).length,
      attention: list.filter((a) => appState(a, isInstalled(a))?.tone === "danger").length,
    };
  }, [all, isInstalled]);

  // Sign-in links from before app pages existed came back to /apps?app=...
  const legacy = params.get("app");
  if (legacy) return <Navigate to={`/apps/${encodeURIComponent(legacy)}?${new URLSearchParams([...params].filter(([k]) => k !== "app"))}`} replace />;
  if (!apps.allowed) return <NoAccess title="Apps" />;

  // A phone hides it (Mobile-Apps: the large title, then the search), while loading and when nothing matches too.
  const lede = <span className="app-dir-lede">Turn on what's built into Crewtavo, and bring in the calendars, books and tools you already use.</span>;
  if (apps.isPending) {
    return (
      <>
        <PageHeader title="Apps" lede={lede} />
        <Loading label="Loading apps" className="app-list app-dir">
          <InboxSkeleton rows={12} groups={2} />
        </Loading>
      </>
    );
  }

  const rows = (all ?? []).filter(
    (a) => appMatches(a, term) && (show === "all" || (show === "installed" ? isInstalled(a) : appState(a, isInstalled(a))?.tone === "danger")),
  );
  const groups = new Map<AppRow["category"], AppRow[]>();
  for (const app of rows) groups.set(app.category, [...(groups.get(app.category) ?? []), app]);

  return (
    <>
      <PageHeader title="Apps" lede={lede} />

      {apps.error ? (
        <ErrorState error={apps.error} onRetry={() => apps.refetch()} />
      ) : (
        <>
          <Toolbar
            filters={
              <FilterTabs
                label="Filter apps"
                value={show}
                onChange={(v) => set("show", v)}
                options={[
                  { value: "all", label: "All", count: counts.all },
                  { value: "installed", label: "Installed", count: counts.installed },
                  { value: "attention", label: "Needs attention", count: counts.attention, countTone: "danger", hidden: counts.attention === 0 && show !== "attention" },
                ]}
              />
            }
            search={<SearchField value={term} onChange={(v) => set("q", v)} placeholder="Search apps" label="Search apps" />}
          />

          {groups.size === 0 ? (
            term.trim() ? (
              <EmptyState icon="search" title={`No apps match “${term.trim()}”`} action={<Button onClick={() => set("q", "")}>Clear search</Button>}>
                Try what it does, like “calendar” or “texts”.
              </EmptyState>
            ) : show === "installed" ? (
              <EmptyState icon="apps" title="No apps installed yet" action={<Button onClick={() => set("show", "all")}>See all apps</Button>}>
                Install one to turn it on for your team.
              </EmptyState>
            ) : (
              <EmptyState icon="check" title="Nothing needs attention" action={<Button onClick={() => set("show", "all")}>See all apps</Button>} />
            )
          ) : (
            <InboxList label="Apps" className="app-list app-dir">
              {[...groups].map(([category, list]) => (
                <InboxGroup key={category} label={CATEGORY_LABELS[category] ?? category} count={list.length}>
                  {list.map((app) => <AppListRow key={app.id} app={app} installed={isInstalled(app)} />)}
                </InboxGroup>
              ))}
            </InboxList>
          )}
        </>
      )}
    </>
  );
}
