import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createQueryClient } from "../api/queries.ts";
import { StateMessage } from "../design-system/components/DataView.tsx";
import { AgentsPage } from "../features/agents/AgentsPage.tsx";
import { AuditPage } from "../features/audit/AuditPage.tsx";
import { CaseDetailPage } from "../features/case-detail/CaseDetailPage.tsx";
import { CasesPage } from "../features/cases/CasesPage.tsx";
import { GatePage } from "../features/gate/GatePage.tsx";
import { OverviewPage } from "../features/overview/OverviewPage.tsx";
import { Page } from "../features/shared/Page.tsx";
import { SystemPage } from "../features/system/SystemPage.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { interceptLinkClicks, useLocation, parseRoute, type Route } from "./router.tsx";
import { Shell } from "./Shell.tsx";
import { ThemeProvider } from "./ThemeProvider.tsx";
import styles from "./App.module.css";

/**
 * The design reference (and every demo fixture it imports) exists only when the build-time flag is true.
 * In production builds the condition is the literal `false`, so the dynamic import is removed entirely.
 */
const DesignPage = __LOOPBACK_DESIGN__ ? lazy(() => import("../features/design-reference/DesignPage.tsx")) : null;

function NotFound() {
  return (
    <Page title="Page not found">
      <StateMessage icon="search" title="There is nothing at this address" detail={<>Check the link, or go to the <a href="/">overview</a>.</>} />
    </Page>
  );
}

function Screen({ route }: { readonly route: Route }) {
  switch (route.name) {
    case "overview": return <OverviewPage />;
    case "cases": return <CasesPage state={route.state} />;
    case "case": return <CaseDetailPage key={route.id} id={route.id} />;
    case "agents": return <AgentsPage />;
    case "gate": return <GatePage />;
    case "audit": return <AuditPage caseId={route.caseId} type={route.type} />;
    case "system": return <SystemPage />;
    case "design":
      return DesignPage ? (
        <Suspense fallback={<p role="status" className={styles.fallback}>Loading design reference…</p>}>
          <DesignPage />
        </Suspense>
      ) : <NotFound />;
    case "not-found": return <NotFound />;
  }
}

/**
 * After in-app navigation to a new page, move focus to its h1 (or <main> while it loads) and scroll to the top,
 * so keyboard and screen-reader users start on the new content. Filter changes (same path) do not move focus.
 */
function useRouteFocus(pathname: string): void {
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    window.scrollTo?.(0, 0);
    const target = document.querySelector<HTMLElement>("[data-page-heading]") ?? document.getElementById("main");
    target?.focus();
  }, [pathname]);
}

export function App({ queryClient }: { readonly queryClient?: QueryClient }) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  const { pathname, search } = useLocation();
  const route = parseRoute(pathname, search);

  useEffect(() => {
    document.addEventListener("click", interceptLinkClicks);
    return () => document.removeEventListener("click", interceptLinkClicks);
  }, []);
  useRouteFocus(pathname);

  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <Shell route={route.name} demo={route.name === "design"}>
          <ErrorBoundary resetKey={pathname}>
            <Screen route={route} />
          </ErrorBoundary>
        </Shell>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
