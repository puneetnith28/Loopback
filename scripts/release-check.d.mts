export interface ReleaseReadinessResult {
  version: string;
  tag: string;
  checkedFiles: string[];
}

export function checkReleaseReadiness(expectedVersion?: string): ReleaseReadinessResult;
