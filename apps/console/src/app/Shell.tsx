import { useEffect, useId, useState, type ReactNode } from "react";
import { IconButton } from "../design-system/components/Button.tsx";
import { Badge } from "../design-system/components/Badge.tsx";
import { Icon, type IconName } from "../design-system/Icon.tsx";
import { hrefFor, type Route, type RouteName } from "./router.tsx";
import { useTheme } from "./ThemeProvider.tsx";
import styles from "./Shell.module.css";

export function LoopMark({ size = 22 }: { readonly size?: number }) {
  return (
    <svg className={styles.mark} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 12a5 5 0 1 0 5-5" fill="none" stroke="var(--color-machine)" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M12 4l2.6 3-3 2.4" fill="none" stroke="var(--color-machine)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="1.9" fill="var(--color-human)" />
    </svg>
  );
}

interface NavItem { readonly to: Route; readonly label: string; readonly icon: IconName; readonly matches: readonly RouteName[] }

const NAV: readonly NavItem[] = [
  { to: { name: "overview" }, label: "Overview", icon: "layers", matches: ["overview"] },
  { to: { name: "cases", state: null }, label: "Cases", icon: "pull-request", matches: ["cases", "case"] },
  { to: { name: "agents" }, label: "Agent activity", icon: "bot", matches: ["agents"] },
  { to: { name: "gate" }, label: "Gate & verification", icon: "shield", matches: ["gate"] },
  { to: { name: "audit", caseId: null, type: null }, label: "Audit history", icon: "clock", matches: ["audit"] },
  { to: { name: "system" }, label: "System", icon: "cpu", matches: ["system"] },
  ...(__LOOPBACK_DESIGN__ ? [{ to: { name: "design" }, label: "Design reference", icon: "flask", matches: ["design"] } satisfies NavItem] : []),
];

interface ShellProps { readonly route: RouteName; readonly demo: boolean; readonly children: ReactNode }

/**
 * Header + primary navigation. Wide screens: a persistent sidebar. Narrow screens: a disclosure ("Menu") that
 * closes on navigation and on Escape, returning focus to its button.
 */
export function Shell({ route, demo, children }: ShellProps) {
  const { theme, setTheme } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  const [menuOpen, setMenuOpen] = useState(false);
  const navId = useId();

  // Close the narrow-screen menu whenever the route changes (state adjusted during render, not in an effect).
  const [lastRoute, setLastRoute] = useState(route);
  if (route !== lastRoute) {
    setLastRoute(route);
    setMenuOpen(false);
  }

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      document.getElementById(`${navId}-toggle`)?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, navId]);

  return (
    <>
      <a className={styles.skip} href="#main">Skip to content</a>
      <header className={styles.header}>
        <IconButton
          id={`${navId}-toggle`} className={styles.menuButton} icon={menuOpen ? "x" : "menu"}
          label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen} aria-controls={navId}
          onClick={() => setMenuOpen((o) => !o)}
        />
        <a className={styles.brand} href="/"><LoopMark /><span className={styles.brandName}>Loopback</span> <span className={styles.product}>Console</span></a>
        <span className={styles.spacer} />
        {demo ? <Badge tone="demo" icon="flask">DEMO<span className={styles.wideOnly}> data</span></Badge> : null}
        <IconButton icon={theme === "dark" ? "sun" : "moon"} label={`Switch to ${next} theme`} onClick={() => setTheme(next)} />
      </header>
      <div className={styles.frame}>
        <nav id={navId} className={styles.nav} aria-label="Primary" data-open={menuOpen}>
          <ul className={styles.navList}>
            {NAV.map((item) => (
              <li key={item.label}>
                <a className={styles.navLink} href={hrefFor(item.to)} aria-current={item.matches.includes(route) ? "page" : undefined}>
                  <Icon name={item.icon} size={16} />
                  <span>{item.label}</span>
                </a>
              </li>
            ))}
          </ul>
          <p className={styles.navNote}>Read-only. Approvals happen in Switch.</p>
        </nav>
        <main id="main" className={styles.main} tabIndex={-1}>{children}</main>
      </div>
    </>
  );
}
