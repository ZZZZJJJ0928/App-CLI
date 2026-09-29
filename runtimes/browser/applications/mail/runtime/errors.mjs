import errorCodeTable from "./controller-error-codes.json" with { type: "json" };

// The Controller-to-Gateway error contract. Gateway's browsercontrol package
// projects each code through the same table, so an unknown code here is a
// programming error rather than something to surface to a client.
export const CONTROLLER_ERROR_CODES = Object.freeze(errorCodeTable.codes);

export class ControllerError extends Error {
  constructor(
    code,
    message,
    {
      status = 500,
      retryable = false,
      cause,
      diagnosticReason,
      diagnosticContext,
    } = {},
  ) {
    if (!Object.hasOwn(CONTROLLER_ERROR_CODES, code)) {
      throw new TypeError(`ControllerError code is not in controller-error-codes.json: ${code}`);
    }
    super(message, { cause });
    this.name = "ControllerError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (diagnosticReason) {
      Object.defineProperty(this, "diagnosticReason", {
        value: diagnosticReason,
        enumerable: false,
      });
    }
    if (diagnosticContext) {
      Object.defineProperty(this, "diagnosticContext", {
        value: diagnosticContext,
        enumerable: false,
      });
    }
  }
}

export function asControllerError(error) {
  if (error instanceof ControllerError) return error;
  return new ControllerError(
    "browser_controller_unavailable",
    "browser controller is temporarily unavailable",
    { status: 503, retryable: true, cause: error },
  );
}

export function invalidRequest(message = "browser controller request is invalid") {
  return new ControllerError("invalid_request", message, { status: 400 });
}

export function publicError(error) {
  const safe = asControllerError(error);
  return {
    error: safe.message,
    code: safe.code,
    retryable: safe.retryable,
  };
}
