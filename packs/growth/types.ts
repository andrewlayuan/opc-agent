export type GrowthStatus = 400 | 404 | 409 | 502;

export interface GrowthIssue {
  path: string;
  text: string;
  label: string;
}

export class GrowthError extends Error {
  status: GrowthStatus;
  issues?: GrowthIssue[];
  constructor(status: GrowthStatus, message: string, issues?: GrowthIssue[]) {
    super(message);
    this.status = status;
    if (issues) this.issues = issues;
  }
}
