/** A domain-level failure with a stable machine-readable code, distinct from transport
 * (LibrarrApiError) or validation (zod) errors. Routes map `code` to an HTTP status. */
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable: boolean
  ) {
    super(message)
    this.name = 'DomainError'
  }
}
