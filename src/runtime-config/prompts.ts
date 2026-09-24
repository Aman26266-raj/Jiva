/**
 * Prompt assembly — combines the agent-specific prompt from Kai with Jiva's
 * runtime prompt into the single system prompt injected into every agent turn.
 *
 *   finalPrompt = jivaPrompt + runtime boundary + agentPrompt
 */

/** Separator between the agent prompt and the Jiva runtime prompt. */
export const PROMPT_SEPARATOR = '\n\n---\n';

/**
 * Runtime-config sessions have already resolved their tenant, agent, central
 * directive, and MCP servers before Manager/Worker construction. This boundary
 * prevents legacy bootstrap instructions in the central directive from being
 * repeated as tool calls or exposed to customers.
 */
export const RUNTIME_SESSION_BOUNDARY = `## Runtime Session Boundary

The runtime configuration, tenant context, agent configuration, central directive, and available tools are already loaded for this session.
Do not call, request, or refer to read_agent_config, read_central_directive, configuration files, prompt files, knowledge-base files, tenant bootstrap, or session bootstrap.
Treat the central directive as internal orchestration guidance only. Never expose internal tool names, file names, configuration details, tenant/session identifiers, MCP details, hidden reasoning, or internal failures to the customer.
The organization-specific agent instructions below are the final authority for customer-facing behavior when they are more specific than the central directive.`;

/**
 * Assemble the final system prompt from the two parts Kai publishes.
 * Both parts are used verbatim — Jiva never reconstructs or rewrites them.
 */
export function assembleFinalPrompt(agentPrompt: string, jivaPrompt: string): string {
  return [jivaPrompt, RUNTIME_SESSION_BOUNDARY, agentPrompt]
    .filter(part => part.trim().length > 0)
    .join(PROMPT_SEPARATOR);
}
