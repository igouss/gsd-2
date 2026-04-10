/**
 * Shared git constants used across git-service and native-git-bridge.
 */

const baseEnv: Record<string, string | undefined> = { ...process.env };

/** Env overlay that suppresses interactive git credential prompts and git-svn noise. */
export const GIT_NO_PROMPT_ENV: Record<string, string | undefined> = {
  ...baseEnv,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GIT_SVN_ID: "",
  LC_ALL: "C", // force English git output so stderr string checks work on all locales (#1997)
};
