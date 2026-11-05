// Runs inside the demo page's frame, before the real console starts. The console is built unchanged apart
// from its location store, so it behaves as it does locally. This file answers its read-API requests from
// responses recorded from the real console API, and takes the current step from the page around it.
/* global document, window, URL, Response, Event, Element, parent */
(function () {
  var BASE = "https://console.loopback.invalid";
  var recorded = JSON.parse(document.getElementById("lb-recording").textContent);
  var step = 0;
  var off = false;
  var path = "/";
  var search = "";

  function go(href) {
    var q = href.indexOf("?");
    path = q === -1 ? href : href.slice(0, q);
    search = q === -1 ? "" : href.slice(q);
  }

  window.__demoLocation = {
    get pathname() { return path; },
    get search() { return search; },
    origin: BASE,
    go: go,
  };

  /** Recorded times are stored as seconds before the recording's moment, so no run date reaches the page. */
  function revive(text) {
    return text.replace(/@T:(\d+)@/g, function (_, seconds) { return new Date(Date.now() - Number(seconds) * 1000).toISOString(); });
  }

  /** The filters the real API applies. It was recorded unfiltered, so they are applied here. */
  function filtered(pathname, params, body) {
    if (!body || !Array.isArray(body.items)) return body;
    var items = body.items;
    if (pathname === "/api/v1/cases" && params.get("state")) items = items.filter(function (c) { return c.state === params.get("state"); });
    if (pathname === "/api/v1/audit") {
      if (params.get("case")) items = items.filter(function (e) { return e.caseId === params.get("case"); });
      if (params.get("types")) { var types = params.get("types").split(","); items = items.filter(function (e) { return types.indexOf(e.type) >= 0; }); }
    }
    var limit = Number(params.get("limit"));
    if (limit > 0) items = items.slice(0, limit);
    // Some lists have no cursor at all, and their schemas refuse unknown fields.
    return "nextCursor" in body ? Object.assign({}, body, { items: items, nextCursor: null }) : Object.assign({}, body, { items: items });
  }

  window.fetch = function (input) {
    var url = new URL(String(input), BASE);
    var answers = recorded.steps[off ? 0 : step];
    var entry = answers[url.pathname];
    var status = entry ? entry.s : 404;
    var body = entry
      ? JSON.parse(revive(recorded.bodies[entry.b]))
      : { error: { code: "NOT_FOUND", message: "No such endpoint.", requestId: "00000000-0000-4000-8000-000000000000" } };
    if (off && url.pathname === "/api/v1/gate") body = Object.assign({}, body, { reachable: false, live: false, ready: false, failing: [] });
    return Promise.resolve(new Response(JSON.stringify(filtered(url.pathname, url.searchParams, body)), { status: status, headers: { "content-type": "application/json" } }));
  };

  /** Moving forward refreshes in place. Going back, or Switch changing, starts clean, so no later data lingers. */
  function refresh(clean) {
    var client = window.__demoQueryClient;
    if (!client) return;
    if (clean) client.resetQueries();
    else client.invalidateQueries();
  }

  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.type !== "lb-console") return;
    var clean = m.step < step || m.off !== off;
    var changed = m.step !== step || m.off !== off;
    if (m.off && !off) m.route = "/";
    step = m.step;
    off = m.off;
    if (typeof m.route === "string") {
      go(m.route);
      window.dispatchEvent(new Event("loopback:navigate"));
    }
    if (changed) refresh(clean);
  });

  // Links out of the console lead to the rehearsal's made-up repository, which doesn't exist.
  document.addEventListener("click", function (e) {
    var a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (a && new URL(a.href).origin !== BASE) e.preventDefault();
  }, true);

  window.addEventListener("DOMContentLoaded", function () { parent.postMessage({ type: "lb-console-ready" }, "*"); });
})();
