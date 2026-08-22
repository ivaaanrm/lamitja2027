/** Strava returned 429, or our own budget says we would. */
export class StravaRateLimitError extends Error {
  constructor(
    message: string,
    /** Epoch ms when it is worth trying again. */
    readonly retryAt: number,
  ) {
    super(message)
    this.name = 'StravaRateLimitError'
  }
}

/** Strava rejected our token and refreshing did not help — the athlete must reconnect. */
export class StravaAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StravaAuthError'
  }
}

export class StravaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'StravaApiError'
  }
}
