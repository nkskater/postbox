/**
 * Stable exit codes for scripts. 0 is success; `run` keeps 1 for failed
 * assertions and 130/143 for signals.
 */
export const EXIT = {
  failure: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  invalid: 5,
  limited: 6,
  server: 7,
  network: 8,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: ExitCode = EXIT.failure,
  ) {
    super(message);
  }
}

export function exitCodeForStatus(status: number): ExitCode {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 404) return EXIT.notFound;
  if (status === 429) return EXIT.limited;
  if (status >= 500) return EXIT.server;
  if (status >= 400) return EXIT.invalid;
  return EXIT.failure;
}
