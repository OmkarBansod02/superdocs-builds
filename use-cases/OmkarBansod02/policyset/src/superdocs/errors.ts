export class SuperDocsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuperDocsError";
  }
}

export class SuperDocsInvalidResponse extends SuperDocsError {
  constructor(message: string) {
    super(message);
    this.name = "SuperDocsInvalidResponse";
  }
}

export class SuperDocsRequestError extends SuperDocsError {
  readonly statusCode: number | null;
  readonly requestId: string | null;
  readonly outcomeUnknown: boolean;

  constructor(
    message: string,
    options: {
      statusCode?: number | null;
      requestId?: string | null;
      outcomeUnknown?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "SuperDocsRequestError";
    this.statusCode = options.statusCode ?? null;
    this.requestId = options.requestId ?? null;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}
