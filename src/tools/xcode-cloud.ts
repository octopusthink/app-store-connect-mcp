import * as z from 'zod';
import { simplifyDocument } from '../format.ts';
import { defineTool, type ToolContext } from './define.ts';
import { cursor, id, jsonApiBody, limit, linkage, list, single } from './shared.ts';

const BUILD_RUN_FIELDS = [
  'number',
  'createdDate',
  'startedDate',
  'finishedDate',
  'executionProgress',
  'completionStatus',
  'startReason',
  'cancelReason',
  'sourceCommit',
  'isPullRequestBuild',
  'issueCounts',
  'workflow',
];

export const listCiProducts = defineTool({
  name: 'list_ci_products',
  title: 'List Xcode Cloud products',
  description:
    'Lists Xcode Cloud products (an app or framework set up for Xcode Cloud). Each has workflows.',
  input: z.object({ appId: id('App', 'list_apps').optional(), limit: limit(50), cursor }),
  handler: (args, context) =>
    list(
      context,
      '/v1/ciProducts',
      {
        'filter[app]': args.appId,
        'fields[ciProducts]': ['name', 'productType', 'createdDate', 'app'],
      },
      args,
    ),
});

export const listCiWorkflows = defineTool({
  name: 'list_ci_workflows',
  title: 'List Xcode Cloud workflows',
  description: 'Lists the workflows of an Xcode Cloud product.',
  input: z.object({
    productId: id('Xcode Cloud product', 'list_ci_products'),
    limit: limit(50),
    cursor,
  }),
  handler: (args, context) =>
    list(
      context,
      `/v1/ciProducts/${encodeURIComponent(args.productId)}/workflows`,
      {
        'fields[ciWorkflows]': [
          'name',
          'description',
          'isEnabled',
          'isLockedForEditing',
          'lastModifiedDate',
        ],
      },
      args,
    ),
});

export const listCiBuildRuns = defineTool({
  name: 'list_ci_build_runs',
  title: 'List Xcode Cloud builds',
  description:
    'Lists Xcode Cloud build runs for a workflow or a whole product, newest first. Pass workflowId or productId.',
  input: z.object({
    workflowId: id('Workflow', 'list_ci_workflows').optional(),
    productId: id('Xcode Cloud product', 'list_ci_products').optional(),
    limit: limit(20),
    cursor,
  }),
  handler: (args, context) => {
    const path = args.workflowId
      ? `/v1/ciWorkflows/${encodeURIComponent(args.workflowId)}/buildRuns`
      : args.productId
        ? `/v1/ciProducts/${encodeURIComponent(args.productId)}/buildRuns`
        : undefined;
    if (!path && !args.cursor) throw new Error('Pass workflowId or productId.');
    return list(
      context,
      path ?? '',
      { sort: '-number', 'fields[ciBuildRuns]': BUILD_RUN_FIELDS },
      args,
    );
  },
});

export const getCiBuildRun = defineTool({
  name: 'get_ci_build_run',
  title: 'Get Xcode Cloud build',
  description:
    'Gets an Xcode Cloud build run with each of its actions (build, test, analyze, archive) and their results.',
  input: z.object({ buildRunId: id('Build run', 'list_ci_build_runs') }),
  handler: async ({ buildRunId }, context) => {
    const path = `/v1/ciBuildRuns/${encodeURIComponent(buildRunId)}`;
    const [run, actions] = await Promise.all([
      context.client.get(path, { 'fields[ciBuildRuns]': BUILD_RUN_FIELDS }, context.signal),
      context.client.get(`${path}/actions`, { limit: 50 }, context.signal),
    ]);
    return { ...single(run), actions: simplifyDocument(actions).items };
  },
});

/** Finds the ID of a branch or tag in the workflow's primary repository. */
async function findGitReference(
  context: ToolContext,
  workflowId: string,
  name: string,
): Promise<string> {
  const repository = single(
    await context.client.get(
      `/v1/ciWorkflows/${encodeURIComponent(workflowId)}/repository`,
      undefined,
      context.signal,
    ),
  );
  const references = await context.client.paginate(
    `/v1/scmRepositories/${encodeURIComponent(repository.id)}/gitReferences`,
    { limit: 200 },
    5000,
    context.signal,
  );
  const live = references.data.filter((reference) => !reference.attributes?.isDeleted);
  const match =
    live.find((reference) => reference.attributes?.canonicalName === name) ??
    live.find((reference) => reference.attributes?.name === name);
  if (!match) {
    const branches = live
      .map((reference) => reference.attributes?.name)
      .slice(0, 20)
      .join(', ');
    throw new Error(
      `No branch or tag named "${name}" in the workflow's repository. Some that exist: ${branches}.`,
    );
  }
  return match.id;
}

export const startCiBuild = defineTool({
  name: 'start_ci_build',
  title: 'Start Xcode Cloud build',
  description: 'Starts an Xcode Cloud build of a workflow, optionally on a specific branch or tag.',
  write: true,
  input: z.object({
    workflowId: id('Workflow', 'list_ci_workflows'),
    gitReference: z
      .string()
      .optional()
      .describe(
        "Branch or tag to build, e.g. main or v2.1.0. Omit to use the workflow's own start condition.",
      ),
    clean: z.boolean().optional().describe('Run a clean build without cached derived data.'),
  }),
  handler: async ({ workflowId, gitReference, clean }, context) => {
    const referenceId = gitReference
      ? await findGitReference(context, workflowId, gitReference)
      : undefined;
    return single(
      await context.client.post(
        '/v1/ciBuildRuns',
        jsonApiBody('ciBuildRuns', {
          attributes: { clean },
          relationships: {
            workflow: linkage('ciWorkflows', workflowId),
            ...(referenceId ? { sourceBranchOrTag: linkage('scmGitReferences', referenceId) } : {}),
          },
        }),
        context.signal,
      ),
    );
  },
});

export const xcodeCloudTools = [
  listCiProducts,
  listCiWorkflows,
  listCiBuildRuns,
  getCiBuildRun,
  startCiBuild,
];
