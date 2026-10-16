'use strict';

/**
 * HttpError — every deliberate API failure is one of these.
 *
 * `status` becomes the HTTP status code and `code` is the short machine-readable
 * slug documented in API_CONTRACT.md (§1). Anything that is *not* an HttpError is
 * treated as an unexpected fault and reported as 500.
 */
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code || codeForStatus(status);
  }
}

function codeForStatus(status) {
  switch (status) {
    case 400: return 'VALIDATION_ERROR';
    case 401: return 'UNAUTHENTICATED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'INVALID_TRANSITION';
    case 503: return 'STORAGE_ERROR';
    default: return 'INTERNAL_ERROR';
  }
}

module.exports = { HttpError, codeForStatus };
