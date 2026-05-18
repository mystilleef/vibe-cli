const mode = process.env.VIBE_TEST_ANTHROPIC_MODE ?? "proceed";

function anthropicMessage(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = Object.assign(
  async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      system?: string;
      messages?: Array<{ content?: string }>;
    };
    const model = body.model ?? "(missing)";
    const system = body.system ?? "";
    const prompt = body.messages?.[0]?.content ?? "";

    if (system.includes("go/no-go decision engine")) {
      return anthropicMessage(
        JSON.stringify({
          proceed: mode === "proceed",
          confidence: mode === "proceed" ? 0.91 : 0.31,
          reason: `${mode}:${model}`,
        }),
      );
    }

    if (system.includes("rewrite AI agent plans")) {
      return anthropicMessage(`revised:${model}:${prompt.slice(0, 24)}`);
    }

    return anthropicMessage(`questions:${model}:${prompt.slice(0, 24)}`);
  },
  { preconnect: globalThis.fetch.preconnect },
);
