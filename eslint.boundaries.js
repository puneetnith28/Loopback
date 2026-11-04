// Module-boundary rules (implementation §6). Shared by eslint.config.js and the
// boundary tests, so the tests prove the exact rules that CI enforces.
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
  message: "Only cases/service.ts may import the merge operation.",
};
const AUDIT = {
  regex: "(^|/)audit/(?!index(\\.js)?$)[^/]+$",
  message: "Import audit only through audit/index (append-only API).",
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
    [MERGE, AUDIT],
    [`${SRC}/policy/**`, `${SRC}/cases/service.ts`, `${SRC}/github/**`, `${SRC}/audit/**`],
  ),
  restrict([`${SRC}/policy/**/*.ts`], [PURITY, MERGE, AUDIT]),
  restrict([`${SRC}/cases/service.ts`, `${SRC}/github/**/*.ts`], [AUDIT]),
  restrict([`${SRC}/audit/**/*.ts`], [MERGE]),
];
