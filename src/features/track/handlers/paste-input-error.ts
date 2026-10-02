export class IncompleteRunReportError extends Error {
  constructor(public readonly reason: 'unrecognized_report' | 'missing_fields' | 'invalid_date') {
    super('Parsed run data is incomplete.'); this.name = 'IncompleteRunReportError';
  }
}
