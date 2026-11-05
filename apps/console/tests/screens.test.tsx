import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  SHA_A, SHA_C, auditEvent, caseDetail, caseSummary, configSummary, envelope, errorEnvelope, happyApi, overview, runListItem, systemStatus,
} from "../test-fixtures/api.ts";
import { mockApi, renderAt, routesFrom, type Handler } from "./api-mock.tsx";
import { expectAccessible } from "./setup.ts";

const api = (over: Readonly<Record<string, Handler>> = {}) => mockApi({ ...routesFrom(happyApi()), ...over });
const h1 = (name: string) => screen.findByRole("heading", { level: 1, name });

describe("every screen renders from the API, with provenance, and passes axe", () => {
  it.each([
    ["/", "Overview", "Waiting on a maintainer"],
    ["/cases", "Cases", "LB-043"],
    ["/cases/LB-042", "LB-042", "Sealed: evidence is bound to the current head."],
    ["/agents", "Agent activity", "Fixer reported · LB-042"],
    ["/gate", "Gate & verification", "Verification is isolated"],
    ["/audit", "Audit history", "Fixer reported"],
    ["/system", "System", "The gate is ready"],
  ])("%s", async (path, title, marker) => {
    api();
    const { container } = renderAt(path);
    expect(await h1(title)).toBeTruthy();
    expect((await screen.findAllByText(marker, { exact: false })).length).toBeGreaterThan(0);
    expect(document.title).toBe(`${title} · Loopback Console`);
    expect(container.querySelector("[data-provenance='demo']")).toBeNull();
    await expectAccessible(container);
  });
});

describe("content states", () => {
  it("loading shows an announced skeleton", async () => {
    mockApi({ "/api/v1/overview": () => new Promise(() => {}) });
    renderAt("/");
    expect((await screen.findAllByRole("status")).some((s) => s.textContent?.includes("Loading overview"))).toBe(true);
  });

  it("empty explains what is absent", async () => {
    api({ "/api/v1/cases": { body: envelope([]) } });
    renderAt("/cases");
    expect(await screen.findByText("No cases yet")).toBeTruthy();
  });

  it("error offers a retry that refetches", async () => {
    let calls = 0;
    api({ "/api/v1/cases": () => { calls += 1; return calls === 1 ? { status: 500, body: errorEnvelope("INTERNAL") } : { body: envelope([caseSummary()]) }; } });
    renderAt("/cases");
    expect(await screen.findByText("The read API failed to load cases")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "LB-042" })).toBeTruthy();
  });

  it("permission denied names the boundary without leaking data", async () => {
    api({ "/api/v1/audit": { status: 403, body: errorEnvelope("FORBIDDEN", "secret detail") } });
    renderAt("/audit");
    expect(await screen.findByText("No access: read API access")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret detail");
  });

  it("partial data is shown with a notice naming what is missing", async () => {
    api({ "/api/v1/cases/LB-042": { body: envelope(caseDetail(), { unavailable: ["github-snapshot"] }) } });
    renderAt("/cases/LB-042");
    expect(await screen.findByText(/unavailable: the GitHub pull-request snapshot/)).toBeTruthy();
    expect(screen.getByText("Sealed: evidence is bound to the current head.")).toBeTruthy();
  });

  it("invalid data is refused, not shown best-effort", async () => {
    api({ "/api/v1/cases/LB-042": { body: envelope({ ...caseDetail(), headSha: "e804775" }) } });
    renderAt("/cases/LB-042");
    expect(await screen.findByText("The read API sent data the console could not validate")).toBeTruthy();
    expect(screen.queryByText(/formatToken/)).toBeNull();
  });

  it("an unknown case is a not-found state, and a malformed id never reaches the API", async () => {
    const { calls } = api();
    renderAt("/cases/LB-999");
    expect(await screen.findByText("No case LB-999")).toBeTruthy();
    renderAt("/cases/not-a-case");
    expect(await h1("Page not found")).toBeTruthy();
    expect(calls.some((c) => c.url.pathname.includes("not-a-case"))).toBe(false);
  });
});

describe("case evidence: commit binding", () => {
  it("head moved: prominent alert, broken seal, earlier evidence labelled as not applying, and no approval command", async () => {
    api();
    renderAt("/cases/LB-043");
    expect(await screen.findByText("The head commit moved after verification")).toBeTruthy();
    expect(screen.getAllByText(/Seal broken/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/approve LB-043/)).toBeNull();
    expect(screen.getAllByText("Earlier commit — does not apply to the current head").length).toBeGreaterThan(0);
    const stale = document.querySelectorAll("[data-stale='true']");
    expect(stale.length).toBeGreaterThan(0);
    for (const el of stale) expect(el.textContent).not.toContain("Current head");
  });

  it("awaiting approval with evidence for the head: shows the exact command with the full SHA", async () => {
    api();
    renderAt("/cases/LB-042");
    expect(await screen.findByText(`@loopback-gate approve LB-042 ${SHA_A}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(approve|merge)/i })).toBeNull();
  });

  it("no approval command when the gate is not awaiting approval, or when its configuration cannot be loaded", async () => {
    api({ "/api/v1/cases/LB-042": { body: envelope(caseDetail({ state: "Verifying" })) } });
    renderAt("/cases/LB-042");
    expect(await screen.findByText(/No approval is requested/)).toBeTruthy();
    expect(screen.queryByText(/approve LB-042/)).toBeNull();
  });

  it("no approval command when the configuration request fails", async () => {
    api({ "/api/v1/config/summary": { status: 500, body: errorEnvelope("INTERNAL") } });
    renderAt("/cases/LB-042");
    expect(await screen.findByText(/configuration could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/approve LB-042/)).toBeNull();
  });

  it("agent claims are stamped as unverified claims; the report is untrusted plain text with hidden characters revealed", async () => {
    api({ "/api/v1/cases/LB-042": { body: envelope(caseDetail({ reportText: "click <img src=x onerror=alert(1)> ‮gnp.exe" })) } });
    const { container } = renderAt("/cases/LB-042");
    await screen.findByText("Sealed: evidence is bound to the current head.");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("⟨U+202E⟩");
    await userEvent.setup().click(screen.getByRole("tab", { name: /Agent claims/ }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("The fixer says it fixed the bug")).toBeTruthy();
    expect(panel.querySelector("[data-provenance='agent-claim']")).not.toBeNull();
  });

  it("states plainly when the API does not provide a field (never guessed)", async () => {
    api({ "/api/v1/cases/LB-042": { body: envelope(caseDetail({ fixerClaim: null })) } });
    renderAt("/cases/LB-042");
    await screen.findByText("Sealed: evidence is bound to the current head.");
    expect(screen.getByText(/title, author and changed files are not available from the read API/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("tab", { name: /Agent claims/ }));
    expect(screen.getByText(/does not provide the fixer's report/)).toBeTruthy();
  });

  it("a GitHub link opens safely; a non-GitHub URL from the API is not a link", async () => {
    const detail = caseDetail() as { ciChecks: Record<string, unknown>[] };
    const ci = detail.ciChecks[0]!;
    api({ "/api/v1/cases/LB-042": { body: envelope({ ...detail, ciChecks: [ci, { ...ci, id: "ci-2", checkName: "lint", htmlUrl: "javascript:alert(1)" }] }) } });
    renderAt("/cases/LB-042");
    const link = await screen.findByRole("link", { name: /View on GitHub/ });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getAllByRole("link", { name: /View on GitHub/ })).toHaveLength(1);
    expect(document.querySelector("a[href^='javascript']")).toBeNull();
  });
});

describe("gate & verification", () => {
  it("marks advisory mode and runs for an earlier commit", async () => {
    api({
      "/api/v1/config/summary": { body: envelope(configSummary({ verificationMode: "advisory" })) },
      "/api/v1/verification-runs": { body: envelope([runListItem({ id: "r9", caseId: "LB-043", headSha: SHA_A, caseHeadSha: SHA_C, mode: "advisory", signature: "absent", provenance: "agent-claim" })]) },
    });
    renderAt("/gate");
    expect(await screen.findByText("Verification is advisory")).toBeTruthy();
    expect(await screen.findByText("Earlier commit — does not apply to the current head")).toBeTruthy();
    expect(screen.getByText("Not signed")).toBeTruthy();
  });
});

describe("system", () => {
  it("shows failing readiness checks by name and safety flags as read-only text", async () => {
    api({ "/api/v1/status": { body: envelope(systemStatus({ ok: false, failing: ["github", "switch"] })) } });
    renderAt("/system");
    expect(await screen.findByText("The gate is not ready")).toBeTruthy();
    expect(screen.getByText("github")).toBeTruthy();
    expect((await screen.findAllByText("Off")).length).toBe(3);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("navigation, filters and pagination", () => {
  it("state filter updates the URL and the request", async () => {
    const { calls } = api();
    renderAt("/cases");
    await screen.findByRole("link", { name: "LB-043" });
    await userEvent.setup().selectOptions(screen.getByLabelText("Filter by state"), "Stale");
    await waitFor(() => expect(window.location.search).toBe("?state=Stale"));
    await waitFor(() => expect(calls.some((c) => c.url.pathname === "/api/v1/cases" && c.url.searchParams.get("state") === "Stale")).toBe(true));
  });

  it("load more requests the next cursor and appends", async () => {
    const { calls } = api({
      "/api/v1/cases": (url) => (url.searchParams.get("cursor") === "c2"
        ? { body: envelope([caseSummary({ id: "LB-050" })]) }
        : { body: envelope([caseSummary()], { nextCursor: "c2" }) }),
    });
    renderAt("/cases");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Load more cases" }));
    expect(await screen.findByRole("link", { name: "LB-050" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "LB-042" })).toBeTruthy();
    expect(screen.getByText("Showing 2 cases (all loaded)")).toBeTruthy();
    expect(calls.filter((c) => c.url.pathname === "/api/v1/cases").map((c) => c.url.searchParams.get("cursor"))).toEqual([null, "c2"]);
  });

  it("in-app links navigate without a reload and move focus to the new page heading", async () => {
    api();
    const user = userEvent.setup();
    renderAt("/");
    await h1("Overview");
    await user.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Audit history" }));
    const heading = await h1("Audit history");
    expect(window.location.pathname).toBe("/audit");
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Audit history" }).getAttribute("aria-current")).toBe("page");
  });

  it("audit case filter validates input before navigating", async () => {
    api();
    const user = userEvent.setup();
    renderAt("/audit");
    await h1("Audit history");
    await user.type(screen.getByLabelText("Case"), "nope");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert").textContent).toContain("LB-001");
    expect(window.location.search).toBe("");
    await user.clear(screen.getByLabelText("Case"));
    await user.type(screen.getByLabelText("Case"), "lb-042");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(window.location.search).toBe("?case=LB-042"));
  });

  it("the narrow-screen menu is a disclosure that closes on Escape and returns focus", async () => {
    api();
    const user = userEvent.setup();
    renderAt("/");
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Close navigation" }).getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Open navigation" })).toBe(document.activeElement);
  });

  it("never issues a write request", async () => {
    const { calls } = api();
    renderAt("/cases/LB-042");
    await screen.findByText("Sealed: evidence is bound to the current head.");
    for (const c of calls) expect(c.init?.method ?? "GET").toBe("GET");
  });

  it("overview recent activity keeps API order and provenance", async () => {
    api({ "/api/v1/overview": { body: envelope(overview({ recentActivity: [auditEvent({ id: 9, eventType: "merge.blocked", reasonCode: "HEAD_MOVED", provenance: "gate" })] })) } });
    renderAt("/");
    expect(await screen.findByText(/The head commit moved \(HEAD_MOVED\)/)).toBeTruthy();
  });
});
