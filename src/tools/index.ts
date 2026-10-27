import type { McpServer } from '@modelcontextprotocol/server';
import { appTools } from './apps.ts';
import { registerTool, type ToolDefinition, type ToolDeps } from './define.ts';
import { apiRequest, describeEndpoint, searchEndpoints } from './generic.ts';
import { provisioningTools } from './provisioning.ts';
import { reportTools } from './reports.ts';
import { reviewTools } from './reviews.ts';
import { testflightTools } from './testflight.ts';
import { versionTools } from './versions.ts';
import { xcodeCloudTools } from './xcode-cloud.ts';

/** Every tool this server offers, in the order clients list them. Read-only mode drops write tools. */
export function allTools(readOnly: boolean): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    ...appTools,
    ...versionTools,
    ...testflightTools,
    ...reviewTools,
    ...reportTools,
    ...xcodeCloudTools,
    ...provisioningTools,
    searchEndpoints,
    describeEndpoint,
    apiRequest(readOnly),
  ];
  return readOnly ? tools.filter((tool) => !tool.write) : tools;
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  for (const tool of allTools(deps.readOnly)) registerTool(server, tool, deps);
}
