// Agent SDK probe for a cell container (plan Task 2 Step 8, reused by Task 19). With the argument
// `sandbox` it runs the egress probe instead: example.com should be blocked and api.github.com allowed.
import { query } from "@anthropic-ai/claude-agent-sdk";

const sandbox = process.argv[2] === "sandbox";
const prompt = sandbox
  ? "Run `curl -sI https://example.com` and then `curl -sI https://api.github.com`, and report the first line each one printed or the error it gave."
  : "Reply with the word ready.";

for await (const m of query({
  prompt,
  options: sandbox
    ? {
        model: "claude-haiku-5-5",
        maxTurns: 6,
        settingSources: [],
        allowedTools: ["Bash"],
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          network: { allowedDomains: ["api.github.com", "github.com", "registry.npmjs.org"], strictAllowlist: true },
        },
      }
    : { model: "claude-haiku-5-5", maxTurns: 1, settingSources: [] },
})) {
  console.log(m.type);
  if (m.type === "result") {
    console.log(JSON.stringify({ subtype: m.subtype, is_error: m.is_error, total_cost_usd: m.total_cost_usd, modelUsage: m.modelUsage }));
    if (m.subtype === "success") console.log(m.result);
  }
}
