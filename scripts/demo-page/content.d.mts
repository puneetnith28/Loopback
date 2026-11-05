// Types for scripts/demo-page/content.mjs (imported by the tests).
export const SCENE_GUIDE: readonly { what: string; why: string; console?: readonly [string, string]; tab?: string }[];
export const SETUP_STEPS: readonly { title: string; where: "terminal" | "transcript" | "switch"; screen?: string; body: string; lines?: readonly string[] }[];
export const CODE_EXCERPTS: readonly { title: string; note: string; file: string; from: RegExp; to: RegExp; after?: number }[];
