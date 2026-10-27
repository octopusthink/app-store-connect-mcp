import * as z from 'zod';
import { flattenResource, type ResourceLinkage, simplifyDocument } from '../format.ts';
import { defineTool } from './define.ts';
import {
  cursor,
  id,
  includedIndex,
  jsonApiBody,
  limit,
  linkage,
  list,
  listPage,
  platform,
  resources,
  single,
} from './shared.ts';

const BUILD_FIELDS = [
  'version',
  'uploadedDate',
  'expirationDate',
  'expired',
  'minOsVersion',
  'processingState',
  'buildAudienceType',
  'usesNonExemptEncryption',
  'preReleaseVersion',
  'buildBetaDetail',
];

export const listBuilds = defineTool({
  name: 'list_builds',
  title: 'List builds',
  description:
    'Lists uploaded builds, newest first, with build number, marketing version, processing state and TestFlight review states. Expired builds are left out unless includeExpired is true.',
  input: z.object({
    appId: id('App', 'list_apps').optional(),
    marketingVersion: z
      .string()
      .optional()
      .describe('Only builds for this version number, e.g. 2.1.0.'),
    buildNumber: z
      .string()
      .optional()
      .describe('Only builds with this build number (CFBundleVersion), e.g. 42.'),
    platform: platform.optional(),
    processingState: z.enum(['PROCESSING', 'FAILED', 'INVALID', 'VALID']).optional(),
    includeExpired: z.boolean().default(false),
    limit: limit(20),
    cursor,
  }),
  handler: async (args, context) => {
    const document = await listPage(
      context,
      '/v1/builds',
      {
        'filter[app]': args.appId,
        'filter[preReleaseVersion.version]': args.marketingVersion,
        'filter[version]': args.buildNumber,
        'filter[preReleaseVersion.platform]': args.platform,
        'filter[processingState]': args.processingState,
        'filter[expired]': args.includeExpired ? undefined : 'false',
        sort: '-uploadedDate',
        include: ['preReleaseVersion', 'buildBetaDetail'],
        'fields[builds]': BUILD_FIELDS,
        'fields[preReleaseVersions]': ['version', 'platform'],
        'fields[buildBetaDetails]': ['internalBuildState', 'externalBuildState'],
      },
      args,
    );

    // Fold the marketing version and beta states into each build.
    const included = includedIndex(document);
    const items = resources(document).map((resource) => {
      const { preReleaseVersion, buildBetaDetail, ...build } = flattenResource(resource);
      const release = included.get(`preReleaseVersions/${preReleaseVersion}`);
      const beta = included.get(`buildBetaDetails/${buildBetaDetail}`);
      return {
        ...build,
        marketingVersion: release?.version,
        platform: release?.platform,
        internalBuildState: beta?.internalBuildState,
        externalBuildState: beta?.externalBuildState,
      };
    });
    return { items, ...(document.links?.next ? { nextCursor: document.links.next } : {}) };
  },
});

export const getBuild = defineTool({
  name: 'get_build',
  title: 'Get build',
  description:
    "Gets a build's details with its marketing version, TestFlight states, test notes (beta build localizations), beta groups and attached App Store version.",
  input: z.object({ buildId: id('Build', 'list_builds') }),
  handler: async ({ buildId }, context) =>
    simplifyDocument(
      await context.client.get(
        `/v1/builds/${encodeURIComponent(buildId)}`,
        {
          include: [
            'app',
            'preReleaseVersion',
            'buildBetaDetail',
            'betaBuildLocalizations',
            'betaGroups',
            'appStoreVersion',
          ],
          'fields[apps]': ['name', 'bundleId'],
          'fields[preReleaseVersions]': ['version', 'platform'],
          'fields[betaGroups]': ['name', 'isInternalGroup'],
          'fields[appStoreVersions]': ['versionString', 'appVersionState'],
        },
        context.signal,
      ),
    ),
});

export const listBetaGroups = defineTool({
  name: 'list_beta_groups',
  title: 'List TestFlight groups',
  description:
    "Lists an app's TestFlight beta groups, internal and external, with public link settings.",
  input: z.object({ appId: id('App', 'list_apps'), limit: limit(50), cursor }),
  handler: (args, context) =>
    list(
      context,
      '/v1/betaGroups',
      {
        'filter[app]': args.appId,
        'fields[betaGroups]': [
          'name',
          'isInternalGroup',
          'hasAccessToAllBuilds',
          'publicLinkEnabled',
          'publicLink',
          'publicLinkLimitEnabled',
          'publicLinkLimit',
          'feedbackEnabled',
          'createdDate',
        ],
      },
      args,
    ),
});

export const listBetaTesters = defineTool({
  name: 'list_beta_testers',
  title: 'List TestFlight testers',
  description:
    'Lists TestFlight testers, filtered by app, beta group or email, with their invite state.',
  input: z.object({
    appId: id('App', 'list_apps').optional(),
    betaGroupId: id('Beta group', 'list_beta_groups').optional(),
    email: z.string().optional().describe('Only the tester with this email address.'),
    limit: limit(50),
    cursor,
  }),
  handler: (args, context) =>
    list(
      context,
      '/v1/betaTesters',
      {
        'filter[apps]': args.appId,
        'filter[betaGroups]': args.betaGroupId,
        'filter[email]': args.email,
        'fields[betaTesters]': ['firstName', 'lastName', 'email', 'inviteType', 'state'],
        sort: 'email',
      },
      args,
    ),
});

const groupIds = z
  .array(z.string().min(1))
  .min(1)
  .describe('Beta group IDs (from list_beta_groups).');

const groupLinkages = (ids: string[]): ResourceLinkage[] =>
  ids.map((groupId) => linkage('betaGroups', groupId));

export const addBuildToBetaGroups = defineTool({
  name: 'add_build_to_beta_groups',
  title: 'Add build to TestFlight groups',
  description:
    'Makes a build available to TestFlight beta groups. External groups only get it once the build has passed beta app review (see submit_build_for_beta_review).',
  write: true,
  idempotent: true,
  input: z.object({ buildId: id('Build', 'list_builds'), betaGroupIds: groupIds }),
  handler: async ({ buildId, betaGroupIds }, context) => {
    await context.client.post(
      `/v1/builds/${encodeURIComponent(buildId)}/relationships/betaGroups`,
      { data: groupLinkages(betaGroupIds) },
      context.signal,
    );
    return { buildId, addedToBetaGroups: betaGroupIds };
  },
});

export const setBuildTestNotes = defineTool({
  name: 'set_build_test_notes',
  title: 'Set TestFlight test notes',
  description:
    'Sets a build\'s TestFlight "What to Test" notes for one locale, creating or replacing them.',
  write: true,
  idempotent: true,
  input: z.object({
    buildId: id('Build', 'list_builds'),
    whatsNew: z
      .string()
      .min(1)
      .describe('The "What to Test" text testers see (up to 4000 characters).'),
    locale: z.string().default('en-US').describe('Locale code, e.g. en-US.'),
  }),
  handler: async ({ buildId, whatsNew, locale }, context) => {
    const existing = await context.client.get(
      `/v1/builds/${encodeURIComponent(buildId)}/betaBuildLocalizations`,
      { limit: 200 },
      context.signal,
    );
    const current = resources(existing).find((resource) => resource.attributes?.locale === locale);
    const document = current
      ? await context.client.patch(
          `/v1/betaBuildLocalizations/${encodeURIComponent(current.id)}`,
          jsonApiBody('betaBuildLocalizations', { id: current.id, attributes: { whatsNew } }),
          context.signal,
        )
      : await context.client.post(
          '/v1/betaBuildLocalizations',
          jsonApiBody('betaBuildLocalizations', {
            attributes: { locale, whatsNew },
            relationships: { build: linkage('builds', buildId) },
          }),
          context.signal,
        );
    return { action: current ? 'updated' : 'created', localization: single(document) };
  },
});

export const submitBuildForBetaReview = defineTool({
  name: 'submit_build_for_beta_review',
  title: 'Submit build for TestFlight review',
  description:
    'Submits a build to beta app review, which external TestFlight testing requires. Internal testers do not need it. Ask the user before calling this.',
  write: true,
  destructive: true,
  input: z.object({ buildId: id('Build', 'list_builds') }),
  handler: async ({ buildId }, context) =>
    single(
      await context.client.post(
        '/v1/betaAppReviewSubmissions',
        jsonApiBody('betaAppReviewSubmissions', {
          relationships: { build: linkage('builds', buildId) },
        }),
        context.signal,
      ),
    ),
});

export const inviteBetaTester = defineTool({
  name: 'invite_beta_tester',
  title: 'Invite TestFlight tester',
  description:
    'Adds a tester to one or more TestFlight beta groups by email, giving them access to pre-release builds. Creates the tester (which sends an invitation email) or, if they already exist, adds them to the groups. Only invite addresses the user gave you.',
  write: true,
  destructive: true,
  input: z.object({
    email: z.email().describe("The tester's email address."),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    betaGroupIds: groupIds,
  }),
  handler: async ({ email, firstName, lastName, betaGroupIds }, context) => {
    const found = await context.client.get(
      '/v1/betaTesters',
      { 'filter[email]': email, limit: 1 },
      context.signal,
    );
    const existing = resources(found)[0];
    if (existing) {
      await context.client.post(
        `/v1/betaTesters/${encodeURIComponent(existing.id)}/relationships/betaGroups`,
        { data: groupLinkages(betaGroupIds) },
        context.signal,
      );
      return { action: 'added to groups', tester: flattenResource(existing), betaGroupIds };
    }
    const created = await context.client.post(
      '/v1/betaTesters',
      jsonApiBody('betaTesters', {
        attributes: { email, firstName, lastName },
        relationships: { betaGroups: groupLinkages(betaGroupIds) },
      }),
      context.signal,
    );
    return { action: 'invited', tester: single(created), betaGroupIds };
  },
});

export const removeBetaTesterFromGroups = defineTool({
  name: 'remove_beta_tester_from_groups',
  title: 'Remove TestFlight tester from groups',
  description:
    'Removes a tester from TestFlight beta groups. They lose access to builds shared through those groups.',
  write: true,
  destructive: true,
  idempotent: true,
  input: z.object({ betaTesterId: id('Beta tester', 'list_beta_testers'), betaGroupIds: groupIds }),
  handler: async ({ betaTesterId, betaGroupIds }, context) => {
    await context.client.delete(
      `/v1/betaTesters/${encodeURIComponent(betaTesterId)}/relationships/betaGroups`,
      { data: groupLinkages(betaGroupIds) },
      context.signal,
    );
    return { betaTesterId, removedFromBetaGroups: betaGroupIds };
  },
});

export const testflightTools = [
  listBuilds,
  getBuild,
  listBetaGroups,
  listBetaTesters,
  addBuildToBetaGroups,
  setBuildTestNotes,
  submitBuildForBetaReview,
  inviteBetaTester,
  removeBetaTesterFromGroups,
];
