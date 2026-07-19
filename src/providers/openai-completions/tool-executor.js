# Tool Execution Handler for OpenAI Completions Provider

This file provides tool execution handlers for the `openai-completions` API provider.
The handlers intercept tool calls from the LLM, execute them via the sidecar's MCP protocol,
and return results to complete the tool call loop.

## How it works

1. When the LLM makes a tool call, the provider detects `tool_calls` in the response
2. For each `tool_call`, the `executeTool` handler is invoked
3. The handler sends the tool call to the sidecar via stdin JSON-RPC
4. The sidecar executes the tool and sends results back via stdout JSON-RPC
5. The handler parses results and returns them to the LLM via `stream.push()`
6. The LLM can now respond, completing the conversation loop

## Integration with Sidecar

The sidecar uses this protocol:
- **Input (stdin)**: `{"type":"prompt","id":"p-xxx","text":"..."}` to send a prompt
- **Output (stdout)**: `{"type":"done","id":"p-xxx"}` for completion

For tool execution:
- **Input**: `{"type":"prompt","id":"p-xxx","text":"Execute tool: <tool_name> <args>"}`
- **Output**: Sidecar returns result via `{"type":"done","id":"p-xxx"}`

## Example Usage

```javascript
const { executeTool } = require('./providers/openai-completions/tool-executor.js');

// Listen for tool calls
stream.on('toolcall_start', async (event) => {
  const toolName = event.toolCall.function.name;
  const toolArgs = event.toolCall.function.arguments;
  
  // Execute via executeTool
  const result = await executeTool(toolName, toolArgs);
  
  // Push result back to stream
  stream.push({
    type: 'tool_call_result',
    toolCallId: event.toolCallId,
    toolName,
    result,
  });
});
```
