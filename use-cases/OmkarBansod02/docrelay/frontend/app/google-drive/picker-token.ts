/**
 * In-memory browser-side token manager for Google Picker OAuth tokens.
 *
 * Tokens are NEVER persisted to storage or sent to the backend.
 */

/** Safety margin subtracted when checking token validity. */
export const EXPIRY_SKEW_MS = 30_000;

export class PickerTokenManager {
  private _token: string | null = null;
  private _expiresAt: number = 0;
  private _hasAuthorized: boolean = false;

  get currentToken(): string | null {
    return this._token;
  }

  get hasAuthorized(): boolean {
    return this._hasAuthorized;
  }

  /** `"consent"` for the first authorization, `""` afterward. */
  get promptHint(): "" | "consent" {
    return this._hasAuthorized ? "" : "consent";
  }

  /**
   * Whether a cached token exists and has not yet expired
   * (accounting for {@link EXPIRY_SKEW_MS}).
   */
  hasValidToken(now: number = Date.now()): boolean {
    return this._token !== null && now < this._expiresAt - EXPIRY_SKEW_MS;
  }

  /**
   * Process a GIS `TokenResponse`.
   *
   * @param accessToken  `response.access_token`
   * @param expiresIn    `response.expires_in` (seconds). If the value is
   *                     missing, non-finite, or <= 0 the token is NOT cached
   *                     for reuse — callers may still use `accessToken`
   *                     for the immediate operation.
   * @param now          Overridable clock for testing.
   */
  handleTokenResponse(
    accessToken: string,
    expiresIn: number,
    now: number = Date.now(),
  ): void {
    this._hasAuthorized = true;

    if (
      typeof expiresIn !== "number" ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      this._token = null;
      this._expiresAt = 0;
      return;
    }

    this._token = accessToken;
    this._expiresAt = now + expiresIn * 1000;
  }
}
