import { getConfig } from '../config.js';

const cfg = getConfig();

/**
 * The token is handed to git through a credential helper that reads it from the
 * child's environment. It therefore never appears in argv, in the remote URL,
 * or in the reflog — the three places a pushed secret tends to survive.
 */
export const CREDENTIAL_HELPER =
  '!f() { echo username=x-access-token; echo "password=$BRANCHSMITH_GIT_TOKEN"; }; f';

export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BRANCHSMITH_GIT_TOKEN: cfg.GITHUB_TOKEN,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

/** Config flags prefixed to every git invocation that talks to the remote. */
export function authArgs(): string[] {
  return ['-c', `credential.helper=${CREDENTIAL_HELPER}`];
}

export function remoteUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}
