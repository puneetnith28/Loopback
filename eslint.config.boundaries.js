// Module-boundary rules (implementation §6). Shared by eslint.config.js and the
// boundary tests, so the tests prove the exact rules that CI enforces.
// The filename matches ECC's config-protection pattern on purpose: weakening these
// rules requires an explicit, deliberate override, like any other linter config.
//
// ESLint flat config does not merge one rule's options across configs: the last
// matching config wins. Each source file therefore matches exactly ONE config
// below, which lists every restriction that applies to it.

const SRC = "apps/switch-gate/src";

const PURITY = {
  regex: "^(?!@loopback/contracts$|\\./[^/]+$).*",
  message: "policy/** is pure: import only @loopback/contracts or sibling policy modules.",
};
// Regexes, not globs: gitignore-style globs do not match "../"-relative specifiers.
const MERGE = {
  regex: "(^|/)github/merge(\\.js)?$",
  message: "Only cases/service.ts (and the composition root, to inject it) may import the merge operation.",
};
// The raw transport can issue any request (including a merge PUT); only github/*
// modules and the composition root (app.ts, main.ts) may hold it.
const TRANSPORT = {
  regex: "(^|/)github/transport(\\.js)?$",
  message: "Only github/* modules and the composition root may import the GitHub transport.",
};
const AUDIT = {
  regex: "(^|/)audit/(?!index(\\.js)?$)[^/]+$",
  message: "Import audit only through audit/index (append-only API).",
};

// D29: the verifier signer runs in its own container; it must not depend on the gate's state,
// GitHub App credentials, merge path, chat or audit. Only contracts, zod, Node built-ins, the
// pure agents/signature and agents/capability modules, and sibling signer modules.
const SIGNER_PURITY = {
  regex: "^(?!@loopback/contracts$|zod$|node:[a-z/_]+$|\\.\\./agents/(signature|capability)\\.js$|\\./[^/]+$).*",
  message: "signer/** may import only @loopback/contracts, zod, node:*, ../agents/{signature,capability}.js and sibling signer modules.",
};

// The console API runs apart from the gate and holds none of its credentials. It may read the
// database and the shared contracts; it may not reach the gate's code, GitHub, Switch or the signer.
const CONSOLE_API_PURITY = {
  regex: "^(?!@loopback/(contracts|console-contracts)$|zod$|better-sqlite3$|node:(http|crypto)$|\\./[^/]+$).*",
  message: "apps/console-api may import only the contracts, zod, better-sqlite3, node:http, node:crypto and its sibling modules.",
};

function restrict(files, patterns, ignores = []) {
  return {
    files,
    ...(ignores.length > 0 ? { ignores } : {}),
    rules: { "no-restricted-imports": ["error", { patterns }] },
  };
}

export const boundaryConfigs = [
  restrict(
    [`${SRC}/**/*.ts`],
    [MERGE, AUDIT, TRANSPORT],
    [`${SRC}/policy/**`, `${SRC}/cases/service.ts`, `${SRC}/github/**`, `${SRC}/audit/**`, `${SRC}/main.ts`, `${SRC}/app.ts`, `${SRC}/signer/**`],
  ),
  restrict([`${SRC}/signer/**/*.ts`], [SIGNER_PURITY, MERGE, AUDIT, TRANSPORT]),
  restrict([`${SRC}/policy/**/*.ts`], [PURITY, MERGE, AUDIT, TRANSPORT]),
  restrict([`${SRC}/cases/service.ts`], [AUDIT, TRANSPORT]),
  restrict([`${SRC}/github/**/*.ts`], [AUDIT]),
  restrict([`${SRC}/audit/**/*.ts`], [MERGE, TRANSPORT]),
  // Composition root: builds and injects the merge capability; holds no audit internals.
  restrict([`${SRC}/main.ts`, `${SRC}/app.ts`], [AUDIT]),
  restrict(["apps/console-api/src/**/*.ts"], [CONSOLE_API_PURITY]),
];
