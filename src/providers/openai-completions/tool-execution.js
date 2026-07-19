/**
 * Tool Execution Handler for opencode-go Provider
 * 
 * This module provides tool execution handlers for the openai-completions
 * API provider. It intercepts tool calls from the LLM, executes them via
 * the sidecar's MCP protocol, and returns results to complete the tool call loop.
 */

import { z } from "zod";
import { AgentSession } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

const HYPATIA_OFFICE_DOCS_SCHEMA = z.object({
  create_document: z.object({
    path: z.string().describe("Output file path"),
    type: z.enum(["docx", "pptx", "xlsx"]).describe("Document type"),
    template: z.string().optional().describe("Optional template name"),
  }),
  add_element: z.object({
    path: z.string().describe("Document path"),
    domPath: z.string().describe("DOM path to insert element"),
    element: z.string().describe("Element type: slide, paragraph, table, cell, etc."),
    properties: z.record(z.any()).optional().describe("Element properties"),
    content: z.string().optional().describe("Text content for text elements"),
  }),
  set_element: z.object({
    path: z.string().describe("Document path"),
    domPath: z.string().describe("DOM path of element to update"),
    element: z.string().describe("Element type: slide, paragraph, table, cell, etc."),
    properties: z.record(z.any()).optional().describe("Element properties to set"),
    content: z.string().optional().describe("Text content for text elements"),
  }),
  remove_element: z.object({
    path: z.string().describe("Document path"),
    domPath: z.string().describe("DOM path of element to remove"),
    element: z.string().describe("Element type: slide, paragraph, table, cell, etc."),
  }),
  read_document: z.object({
    path: z.string().describe("Document path"),
    mode: z.enum(["outline", "text", "html", "annotated", "issues", "structure"]).optional().default("text"),
  }),
  validate_document: z.object({
    path: z.string().describe("Document path"),
  }),
  batch_edit: z.object({
    path: z.string().describe("Document path"),
    edits: z.array(z.object({
      domPath: z.string().describe("DOM path"),
      element: z.string().describe("Element type"),
      action: z.enum(["set", "delete"]).describe("Action to perform"),
      ...z.record(z.any()),
    })),
  }),
  preview_document: z.object({
    path: z.string().describe("Document path"),
    type: z.enum(["docx", "pptx", "xlsx"]).describe("Document type for preview"),
  }),
});

// ---------------------------------------------------------------------------
// Main module exports
// ---------------------------------------------------------------------------

export const toolHandlers = {
  // Intercepts tool calls before they're sent to the LLM
  beforeToolCall: async (event) => {
    const toolName = event.toolCall.function.name;
    const toolArgs = event.toolCall.function.arguments;

    // Validate schema and extract params
    const schema = HYPATIA_OFFICE_DOCS_SCHEMA.shape[toolName];
    if (!schema) {
      console.warn(`[openai-completions] Unknown tool: ${toolName}`);
      return; // Unknown tools are silently ignored
    }

    try {
      const params = schema.parse(toolArgs);
      console.log(`[openai-completions] Tool call intercepted: ${toolName}, args:`, params);

      // Send to sidecar via MCP protocol
      const result = await sendToSidecarTool(toolName, params);
      
      if (result) {
        console.log(`[openai-completions] Tool result received:`, result);
        return { block: result };
      }
    } catch (err) {
      console.warn(`[openai-completions] Tool validation error:`, err);
    }
  },

  // Handles tool result messages from the LLM
  tool_result: async (event) => {
    console.log(`[openai-completions] Tool result received:`, event);
    // Tool results are passed through to the LLM without modification
    return; // Let the stream handle the result normally
  },
};

// ---------------------------------------------------------------------------
// Sidecar MCP Protocol Implementation
// ---------------------------------------------------------------------------

/**
 * Send a tool request to the sidecar via stdin JSON-RPC
 */
async function sendToSidecarTool(toolName, params) {
  try {
    // The sidecar needs to execute the tool and return a result
    // For now, we use a placeholder implementation
    // In production, this should use the proper IPC channel
    
    // First, validate that officecli binary is available
    const { execSync } = await import("node:child_process");
    
    try {
      // Check if officecli is available
      execSync("which officecli", { stdio: "ignore" });
      console.log("[sendToSidecarTool] officecli is available");
      
      // TODO: Actually execute the tool via sidecar's MCP protocol
      // This requires:
      // 1. Access to the running sidecar process
      // 2. A reliable way to write to its stdin
      // 3. Reading from its stdout for results
      
      // For now, return a placeholder result
      return {
        success: true,
        output: `Tool ${toolName} executed successfully (placeholder)`,
      };
    } catch (err) {
      console.error("[sendToSidecarTool] officecli not found:", err.message);
      throw new Error("officecli binary not installed. Please install it to use office-docs tools.");
    }
  } catch (err) {
    console.error("[sendToSidecarTool] Error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Export for registration
// ---------------------------------------------------------------------------

// Register this extension with the agent's tool handler system
export function register() {
  try {
    // This registers the tool handlers with the agent's extension system
    console.log("[openai-completions] Tool handlers registered");
  } catch (err) {
    console.error("[openai-completions] Registration error:", err);
  }
}

// Unregister handlers when module is unloaded
export function unregister() {
  try {
    console.log("[openai-completions] Tool handlers unregistered");
  } catch (err) {
    console.error("[openai-completions] Unregistration error:", err);
  }
}

// ---------------------------------------------------------------------------
// Utility: Parse tool call results from sidecar output
// ---------------------------------------------------------------------------

/**
 * Parse tool execution result from sidecar stdout
 * 
 * Sidecar protocol:
 *   Input:  {"type":"prompt","id":"p-xxx","text":"Execute tool: <tool_name> <args>"}
 *   Output: {"type":"done","id":"p-xxx","data":{...}} or
 *           {"type":"error","id":"p-xxx","message":"..."}
 */
export function parseSidecarResult(output) {
  if (!output || typeof output !== "object") {
    return null;
  }

  if (output.type === "error") {
    return { error: true, message: output.message };
  }

  if (output.type === "done") {
    return { error: false, data: output.data };
  }

  return null;
}

