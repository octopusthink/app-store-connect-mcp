import * as z from 'zod';
import { simplifyDocument } from '../format.ts';
import { defineTool } from './define.ts';
import { cursor, id, limit, list } from './shared.ts';

export const listApps = defineTool({
  name: 'list_apps',
  title: 'List apps',
  description:
    'Lists apps in the App Store Connect account, with their IDs, bundle IDs and SKUs. Start here: most other tools need an app ID.',
  input: z.object({
    name: z.string().optional().describe('Only apps with exactly this name.'),
    bundleId: z
      .string()
      .optional()
      .describe('Only the app with this bundle ID, e.g. com.example.app.'),
    sku: z.string().optional().describe('Only the app with this SKU.'),
    limit: limit(50),
    cursor,
  }),
  handler: (args, context) =>
    list(
      context,
      '/v1/apps',
      {
        'filter[name]': args.name,
        'filter[bundleId]': args.bundleId,
        'filter[sku]': args.sku,
        'fields[apps]': ['name', 'bundleId', 'sku', 'primaryLocale'],
        sort: 'name',
      },
      args,
    ),
});

export const getApp = defineTool({
  name: 'get_app',
  title: 'Get app',
  description:
    "Gets an app's details, its App Store info records (one live, one editable while a version is in progress) and its five most recent App Store versions.",
  input: z.object({ appId: id('App', 'list_apps') }),
  handler: async ({ appId }, context) =>
    simplifyDocument(
      await context.client.get(
        `/v1/apps/${encodeURIComponent(appId)}`,
        {
          include: ['appInfos', 'appStoreVersions'],
          'limit[appStoreVersions]': 5,
          'fields[apps]': [
            'name',
            'bundleId',
            'sku',
            'primaryLocale',
            'isOrEverWasMadeForKids',
            'contentRightsDeclaration',
            'appInfos',
            'appStoreVersions',
          ],
          'fields[appInfos]': ['state', 'appStoreState', 'appStoreAgeRating'],
          'fields[appStoreVersions]': [
            'platform',
            'versionString',
            'appStoreState',
            'appVersionState',
            'releaseType',
            'createdDate',
          ],
        },
        context.signal,
      ),
    ),
});

export const appTools = [listApps, getApp];
