import { isNavigationTool, type ToolName } from '@/lib/opencode/tools';

export const isExpandableTool = (toolName: ToolName): boolean => {
    return !isStaticTool(toolName);
};

// Keep only tools with a direct in-app navigation destination compact. Every
// other tool uses ToolPart so custom, plugin, and MCP calls expose their input
// and output through the common expandable renderer.
export const isStaticTool = (toolName: ToolName): boolean => isNavigationTool(toolName);
