const SYNTHETIC_REASONING_TEXT = "reasoning unavailable";
const outputTypes = /* @__PURE__ */ new Set(["function_call", "custom_tool_call", "local_shell_call"]);
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isAssistantOutput(item) {
  return item.role === "assistant" || item.type === "message" && item.role === "assistant" || typeof item.type === "string" && outputTypes.has(item.type);
}
function isTurnBoundary(item) {
  return item.role === "user" || item.role === "system" || item.type === "function_call_output" || item.type === "custom_tool_call_output" || item.type === "local_shell_call_output";
}
function repairResponsesReasoning(request) {
  const input = request.input;
  if (!Array.isArray(input)) return void 0;
  const output = [];
  let turnHasReasoning = false;
  let repaired = false;
  for (const raw of input) {
    if (!isRecord(raw)) {
      output.push(raw);
      continue;
    }
    if (raw.type === "reasoning") {
      turnHasReasoning = true;
      output.push(raw);
      continue;
    }
    if (isTurnBoundary(raw)) {
      turnHasReasoning = false;
      output.push(raw);
      continue;
    }
    if (isAssistantOutput(raw) && !turnHasReasoning) {
      output.push({ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: SYNTHETIC_REASONING_TEXT }] });
      turnHasReasoning = true;
      repaired = true;
    }
    output.push(raw);
  }
  return repaired ? { ...request, input: output } : void 0;
}
export {
  SYNTHETIC_REASONING_TEXT,
  repairResponsesReasoning
};
