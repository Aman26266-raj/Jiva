/**
 * Prompt assembly — combines the agent-specific prompt from Kai with Jiva's
 * runtime prompt into the single system prompt injected into every agent turn.
 *
 *   finalPrompt = agentPrompt + "\n\n---\n" + jivaPrompt
 */

/** Separator between the agent prompt and the Jiva runtime prompt. */
export const PROMPT_SEPARATOR = '\n\n---\n';

/**
 * Assemble the final system prompt from the two parts Kai publishes.
 * Both parts are used verbatim — Jiva never reconstructs or rewrites them.
 */
export function assembleFinalPrompt(agentPrompt: string, jivaPrompt: string): string {
  return `${agentPrompt}${PROMPT_SEPARATOR}${jivaPrompt}`;
}
