/**
 * The six content states every data-dependent view handles (DESIGN.md §4). A discriminated union, so a view
 * cannot forget a state: rendering is an exhaustive switch.
 */
export type Loadable<T> =
  | { readonly status: "loading" }
  | { readonly status: "empty"; readonly title: string; readonly detail: string }
  | { readonly status: "error"; readonly title: string; readonly detail: string; readonly retry?: () => void }
  | { readonly status: "partial"; readonly data: T; readonly missing: readonly string[]; readonly retry?: () => void }
  | { readonly status: "success"; readonly data: T }
  | { readonly status: "permission"; readonly boundary: string; readonly detail: string };
