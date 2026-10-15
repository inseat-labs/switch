export const STARTER_CONFIG = `# Switch: snapshot tests for AI model upgrades.
# Your current model's behavior is the baseline. Switch runs every case on both
# models several times and reports only changes that are consistent across samples.
# Run: npx switch-llm compare

# provider:model. Providers: claude-cli (uses your Claude Code login, no API key),
# anthropic (ANTHROPIC_API_KEY), openai (OPENAI_API_KEY; OPENAI_BASE_URL for
# OpenRouter, Ollama, or any compatible server).
baseline: claude-cli:sonnet
candidate: claude-cli:haiku

# Samples per model per case. Use 3 or more to separate real changes from noise.
repeat: 3

# Optional system prompt shared by every case.
system: |
  You are a support agent for an online store. Use the tools when you have
  enough information; ask the customer when something required is missing.

# Optional tools, OpenAI function style: name, description, parameters (JSON Schema).
tools:
  - name: lookup_order
    description: Look up an order by its id.
    parameters:
      type: object
      properties:
        orderId: { type: string, pattern: "^ORD-[0-9]{6}$" }
      required: [orderId]
  - name: cancel_order
    description: Cancel an order that has not shipped yet.
    parameters:
      type: object
      properties:
        orderId: { type: string }
        reason: { type: string }
      required: [orderId]

# Cases: a prompt, a full messages array, or imported recorded traffic.
cases:
  - name: lookup order
    prompt: Where is order ORD-123456?
  - name: cancel order
    prompt: Please cancel ORD-654321, I ordered the wrong size.
  - name: cancel without id
    prompt: Cancel my order.
  # - name: multi-turn
  #   messages:
  #     - { role: user, content: "Hi" }
  #     - { role: assistant, content: "Hello! How can I help?" }
  #     - { role: user, content: "Where is ORD-111111?" }
  # Recorded OpenAI chat-completions traffic (JSONL). Recorded responses become
  # extra baseline samples.
  # - import: logs/openai-chat.jsonl
`;
