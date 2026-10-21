// Policy Q&A Agent settings (spec policy-qa, rule 13; DD-19). Not an AgentConfig: the agent makes
// one model call with no tools, no allowlist and no tool loop.
export const POLICY_QA_CONFIG = {
  agentId: 'policy_qa',
  promptVersion: 'v1', // prompts/policy_qa/v1.md
  model: 'claude-sonnet-5-5', // as the Leave Agent (brief §7)
  effort: 'low', // sent as output_config.effort; never output_config.format (citations, DD-7)
  maxTokens: 1024,
  timeoutMs: 60_000,
} as const;
