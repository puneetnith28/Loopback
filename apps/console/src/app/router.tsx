import { useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from "react";
import { AUDIT_EVENT_TYPES, CaseId, type CaseState } from "@loopback/contracts";
import { isKnownState } from "../lib/lifecycle.ts";

/**
 * A deliberately small router (eight routes, one path parameter): typed routes, validated parameters, History API
 * navigation. Every parameter is parsed through the same schemas the API uses, so a malformed URL becomes
 * "not found" instead of reaching a request.
 */
export type Route =
  | { readonly name: "overview" }
  | { readonly name: "cases"; readonly state: CaseState | null }
  | { readonly name: "case"; readonly id: string }
  | { readonly name: "agents" }
  | { readonly name: "gate" }
  | { readonly name: "audit"; readonly caseId: string | null; readonly type: string | null }
  | { readonly name: "system" }
  | { readonly name: "design" }
  | { readonly name: "not-found" };

export type RouteName = Route["name"];

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(AUDIT_EVENT_TYPES);

export function parseRoute(pathname: string, search: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  const params = new URLSearchParams(search);
  if (path === "/") return { name: "overview" };
  if (path === "/cases") {
    const state = params.get("state");
    return { name: "cases", state: state !== null && isKnownState(state) ? state : null };
  }
  const caseMatch = /^\/cases\/([^/]+)$/.exec(path);
  if (caseMatch) {
    let id: string;
    try {
      id = decodeURIComponent(caseMatch[1] ?? "");
    } catch {
      return { name: "not-found" };
    }
    return CaseId.safeParse(id).success ? { name: "case", id } : { name: "not-found" };
  }
  if (path === "/agents") return { name: "agents" };
  if (path === "/gate") return { name: "gate" };
  if (path === "/audit") {
    const caseId = params.get("case");
    const type = params.get("type");
    return {
      name: "audit",
      caseId: caseId !== null && CaseId.safeParse(caseId).success ? caseId : null,
      type: type !== null && KNOWN_EVENT_TYPES.has(type) ? type : null,
    };
  }
  if (path === "/system") return { name: "system" };
  if (path === "/design" && __LOOPBACK_DESIGN__) return { name: "design" };
  return { name: "not-found" };
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case "overview": return "/";
    case "cases": return route.state ? `/cases?state=${route.state}` : "/cases";
    case "case": return `/cases/${encodeURIComponent(route.id)}`;
    case "agents": return "/agents";
    case "gate": return "/gate";
    case "audit": {
      const params = new URLSearchParams();
      if (route.caseId) params.set("case", route.caseId);
      if (route.type) params.set("type", route.type);
      const q = params.toString();
      return q ? `/audit?${q}` : "/audit";
    }
    case "system": return "/system";
    case "design": return "/design";
    case "not-found": return "/";
  }
}

// ----------------------------------------------------------------------------------------------------------------
// Location store
// ----------------------------------------------------------------------------------------------------------------

const NAVIGATE_EVENT = "loopback:navigate";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

const snapshot = () => `${window.location.pathname}${window.location.search}`;

/** Current path + search, re-rendering on navigation and on back/forward. */
export function useLocation(): { readonly pathname: string; readonly search: string } {
  const href = useSyncExternalStore(subscribe, snapshot, () => "/");
  const q = href.indexOf("?");
  return q === -1 ? { pathname: href, search: "" } : { pathname: href.slice(0, q), search: href.slice(q) };
}

export function useRoute(): Route {
  const { pathname, search } = useLocation();
  return parseRoute(pathname, search);
}

/** Same-origin, in-app navigation only. */
export function navigate(href: string, opts: { readonly replace?: boolean } = {}): void {
  if (!href.startsWith("/") || href.startsWith("//")) throw new Error("navigate() accepts in-app paths only");
  if (opts.replace) window.history.replaceState(null, "", href);
  else window.history.pushState(null, "", href);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

function isPlainLeftClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.defaultPrevented;
}

/**
 * The in-app path for an anchor, or null when the browser should handle it (other origin, new tab, download,
 * the API, or a pure in-page fragment such as the skip link).
 */
export function inAppPath(anchor: HTMLAnchorElement, origin: string): string | null {
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download") || anchor.dataset.external !== undefined) return null;
  const raw = anchor.getAttribute("href");
  if (raw === null || raw.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(anchor.href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname.startsWith("/api/")) return null;
  return `${url.pathname}${url.search}`;
}

/** Turns plain clicks on same-origin <a href> anywhere in the app into in-app navigation (no full reload). */
export function interceptLinkClicks(event: globalThis.MouseEvent): void {
  if (!isPlainLeftClick(event)) return;
  const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(target instanceof HTMLAnchorElement)) return;
  const path = inAppPath(target, window.location.origin);
  if (path === null) return;
  event.preventDefault();
  if (path !== `${window.location.pathname}${window.location.search}`) navigate(path);
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  readonly to: Route;
  readonly children: ReactNode;
}

/**
 * A typed, real <a href>: open-in-new-tab, copy link and keyboard all work; plain clicks become in-app navigation
 * through interceptLinkClicks (installed once by the App).
 */
export function Link({ to, children, ...rest }: LinkProps) {
  return <a {...rest} href={hrefFor(to)}>{children}</a>;
}
