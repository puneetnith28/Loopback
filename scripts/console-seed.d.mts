// Types for scripts/console-seed.mjs (imported by the tests).
import type Database from "better-sqlite3";
export function sha(label: string): string;
export function seedConsoleData(db: Database.Database): void;
export function appendMockEvent(db: Database.Database, now?: Date): void;
