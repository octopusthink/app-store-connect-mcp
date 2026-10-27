import * as z from 'zod';
import { defineTool } from './define.ts';
import { cursor, jsonApiBody, limit, list, single } from './shared.ts';

const devicePlatform = z.enum(['IOS', 'MAC_OS', 'UNIVERSAL']);

export const listBundleIds = defineTool({
  name: 'list_bundle_ids',
  title: 'List bundle IDs',
  description: 'Lists registered bundle IDs (App IDs) in the developer account.',
  input: z.object({
    identifier: z
      .string()
      .optional()
      .describe('Only this bundle identifier, e.g. com.example.app.'),
    name: z.string().optional(),
    platform: devicePlatform.optional(),
    limit: limit(50),
    cursor,
  }),
  handler: (args, context) =>
    list(
      context,
      '/v1/bundleIds',
      {
        'filter[identifier]': args.identifier,
        'filter[name]': args.name,
        'filter[platform]': args.platform,
        'fields[bundleIds]': ['name', 'identifier', 'platform', 'seedId'],
        sort: 'identifier',
      },
      args,
    ),
});

export const listDevices = defineTool({
  name: 'list_devices',
  title: 'List devices',
  description: 'Lists devices registered for development and ad hoc distribution.',
  input: z.object({
    name: z.string().optional(),
    udid: z.string().optional(),
    platform: devicePlatform.optional(),
    status: z.enum(['ENABLED', 'DISABLED']).optional(),
    limit: limit(100),
    cursor,
  }),
  handler: (args, context) =>
    list(
      context,
      '/v1/devices',
      {
        'filter[name]': args.name,
        'filter[udid]': args.udid,
        'filter[platform]': args.platform,
        'filter[status]': args.status,
        sort: 'name',
      },
      args,
    ),
});

export const registerDevice = defineTool({
  name: 'register_device',
  title: 'Register device',
  description:
    "Registers a device UDID for development and ad hoc builds. Provisioning profiles must be regenerated to include it. Each registration uses one of the account's limited yearly device slots, which is not freed by disabling the device until the membership year renews.",
  write: true,
  destructive: true,
  input: z.object({
    name: z.string().min(1).describe('A name for the device, e.g. "Sam\'s iPhone".'),
    udid: z.string().min(1).describe("The device's UDID."),
    platform: devicePlatform.describe(
      'IOS for iPhone, iPad, Apple TV, Apple Watch and Vision Pro; MAC_OS for Macs.',
    ),
  }),
  handler: async (args, context) =>
    single(
      await context.client.post(
        '/v1/devices',
        jsonApiBody('devices', { attributes: args }),
        context.signal,
      ),
    ),
});

export const listUsers = defineTool({
  name: 'list_users',
  title: 'List team members',
  description: 'Lists App Store Connect users on the team with their roles.',
  input: z.object({
    roles: z
      .array(z.string())
      .optional()
      .describe('Only users with these roles, e.g. ["ADMIN"], ["APP_MANAGER", "DEVELOPER"].'),
    limit: limit(100),
    cursor,
  }),
  handler: (args, context) =>
    list(
      context,
      '/v1/users',
      {
        'filter[roles]': args.roles,
        'fields[users]': [
          'username',
          'firstName',
          'lastName',
          'roles',
          'allAppsVisible',
          'provisioningAllowed',
        ],
        sort: 'lastName',
      },
      args,
    ),
});

export const provisioningTools = [listBundleIds, listDevices, registerDevice, listUsers];
