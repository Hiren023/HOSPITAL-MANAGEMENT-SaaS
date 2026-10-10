/**
 * In-memory access-token store.
 *
 * SECURITY: the access token is deliberately NOT persisted. `localStorage` is readable
 * by any script on the page, so a single XSS bug there becomes full account takeover
 * (docs/SECURITY.md R6).
 *
 * The durable credential is the refresh token, which lives in an `HttpOnly` cookie the
 * browser sends automatically and JavaScript cannot read. On page load the app calls
 * `POST /auth/refresh` to obtain a fresh access token, so a reload is transparent to
 * the user without ever writing the short-lived token to disk.
 *
 * A module-level variable (rather than React state) means the API client can read the
 * token outside the React tree — a token held in context would be awkward to reach from
 * a plain fetch wrapper, and would tempt other code into re-implementing state.
 */

let accessToken: string | null = null

export const tokenStore = {
  get(): string | null {
    return accessToken
  },

  set(token: string | null): void {
    accessToken = token
  },

  clear(): void {
    accessToken = null
  },

  get isPresent(): boolean {
    return accessToken !== null
  },
}
