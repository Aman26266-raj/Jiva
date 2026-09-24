export const CUSTOMER_SAFE_SYSTEM_FAILURE =
  'I’m unable to complete your request at the moment due to a temporary system issue. Please try again in a few minutes.';

const INTERNAL_REFERENCE_PATTERNS: RegExp[] = [
  /\bread_agent_config\b/i,
  /\bread_central_directive\b/i,
  /\bcentral directive\b/i,
  /\bruntime[-\s]?config(?:uration)?\b/i,
  /\btenant (?:config(?:uration)?|context|identifier|bootstrap)\b/i,
  /\bsession (?:identifier|bootstrap|not found)\b/i,
  /\bMCP(?: server| tool| details?)?\b/i,
  /\bknowledge[-\s]?base(?: file| identifier| name)?\b/i,
  /\b(?:prompt|directive|configuration) file\b/i,
  /\bjiva-central-directive\.md\b/i,
];

/** Prevent internal orchestration/configuration details reaching customers. */
export function sanitizeCustomerFacingResponse(response: string): string {
  const text = response.trim();
  if (!text || INTERNAL_REFERENCE_PATTERNS.some(pattern => pattern.test(text))) {
    return CUSTOMER_SAFE_SYSTEM_FAILURE;
  }
  return text;
}
