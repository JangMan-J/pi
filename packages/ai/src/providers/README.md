# Provider defaults and overrides

## Generic endpoints

When its `models` list is absent or empty, a generic endpoint discovers models.
Discovered `openai-completions` models disable `store` and the `developer` role.
They use `max_tokens` for the output limit.

Bare model IDs default to text input and no reasoning.
Google discovery enables image input for `gemini-*` IDs.
Other Google models default to text input.

In coding-agent, use `modelOverrides` in `~/.pi/agent/models.json` to change a discovered model.
Enable capabilities only after verification with that endpoint.
For example:

```json
{
  "providers": {
    "local": {
      "api": "openai-completions",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "local",
      "modelOverrides": {
        "vision-model": {
          "input": ["text", "image"],
          "reasoning": true,
          "compat": {
            "supportsStore": true,
            "supportsDeveloperRole": true,
            "maxTokensField": "max_completion_tokens"
          }
        }
      }
    }
  }
}
```

When discovery returns the model ID, the override applies to that model.
See [models configuration](../../../coding-agent/docs/models-configuration.md) for all fields.

## OpenAI context limits

The generated OpenAI GPT-5.6 and GPT-6 defaults use 272,000 tokens to stay within the short-context pricing tier.
Long-context cost metadata remains available.
The Codex defaults use 272,000 tokens, except `gpt-6.1-sol`, which uses 500,000.
An authenticated catalog check on 2026-10-24 confirmed these Codex defaults.

To opt into a larger verified limit, add a model override:

```json
{
  "providers": {
    "openai": {
      "modelOverrides": {
        "gpt-6.1-sol": { "contextWindow": 500000 }
      }
    }
  }
}
```

A larger context limit delays automatic compaction and can enter a higher pricing tier.
