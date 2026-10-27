import * as z from 'zod';
import { ApiError } from '../client.ts';
import { type JsonApiDocument, simplifyDocument } from '../format.ts';
import { defineTool, type ToolContext } from './define.ts';
import {
  cursor,
  id,
  jsonApiBody,
  limit,
  linkage,
  list,
  type PLATFORMS,
  platform,
  requireSomeFields,
  resources,
  single,
} from './shared.ts';

const locale = z
  .string()
  .min(2)
  .describe('Locale code as used by App Store Connect, e.g. en-US, fr-FR, ja.');

export const listAppStoreVersions = defineTool({
  name: 'list_app_store_versions',
  title: 'List App Store versions',
  description:
    'Lists App Store versions of an app, newest first, with their state and attached build. Use it to find the version ID for metadata, build selection and review submission.',
  input: z.object({
    appId: id('App', 'list_apps'),
    platform: platform.optional(),
    versionString: z.string().optional().describe('Only this version number, e.g. 2.1.0.'),
    state: z
      .string()
      .optional()
      .describe(
        'Only versions in this appVersionState, e.g. PREPARE_FOR_SUBMISSION, WAITING_FOR_REVIEW, IN_REVIEW, PENDING_DEVELOPER_RELEASE, READY_FOR_DISTRIBUTION, REJECTED.',
      ),
    limit: limit(10),
    cursor,
  }),
  handler: (args, context) =>
    list(
      context,
      `/v1/apps/${encodeURIComponent(args.appId)}/appStoreVersions`,
      {
        'filter[platform]': args.platform,
        'filter[versionString]': args.versionString,
        'filter[appVersionState]': args.state,
        include: 'build',
        'fields[appStoreVersions]': [
          'platform',
          'versionString',
          'appStoreState',
          'appVersionState',
          'releaseType',
          'earliestReleaseDate',
          'copyright',
          'createdDate',
          'build',
        ],
        'fields[builds]': ['version', 'uploadedDate', 'processingState'],
      },
      args,
    ),
});

export const listVersionLocalizations = defineTool({
  name: 'list_version_localizations',
  title: 'List version localizations',
  description:
    "Lists an App Store version's per-locale metadata: description, keywords, what's new, promotional text, marketing and support URLs.",
  input: z.object({
    versionId: id('App Store version', 'list_app_store_versions'),
    locale: locale.optional().describe('Only this locale, e.g. en-US.'),
  }),
  handler: ({ versionId, locale }, context) =>
    list(
      context,
      `/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations`,
      { 'filter[locale]': locale },
      { limit: 200 },
    ),
});

/** The app's info records, each with its localizations. */
async function appInfosWithLocalizations(
  context: ToolContext,
  appId: string,
  localeFilter?: string,
) {
  const infos = await context.client.get(
    `/v1/apps/${encodeURIComponent(appId)}/appInfos`,
    { 'fields[appInfos]': ['state', 'appStoreState'] },
    context.signal,
  );
  return Promise.all(
    resources(infos).map(async (info) => {
      const localizations = await context.client.get(
        `/v1/appInfos/${encodeURIComponent(info.id)}/appInfoLocalizations`,
        { 'filter[locale]': localeFilter, limit: 200 },
        context.signal,
      );
      return {
        appInfoId: info.id,
        state: info.attributes?.state,
        localizations: simplifyDocument(localizations).items,
      };
    }),
  );
}

export const listAppInfoLocalizations = defineTool({
  name: 'list_app_info_localizations',
  title: 'List app info localizations',
  description:
    "Lists an app's per-locale App Store info: name, subtitle and privacy policy URL. Apps usually have two info records: the live one (READY_FOR_DISTRIBUTION) and an editable one while a new version is being prepared.",
  input: z.object({
    appId: id('App', 'list_apps'),
    locale: locale.optional().describe('Only this locale, e.g. en-US.'),
  }),
  handler: ({ appId, locale }, context) => appInfosWithLocalizations(context, appId, locale),
});

export const createAppStoreVersion = defineTool({
  name: 'create_app_store_version',
  title: 'Create App Store version',
  description:
    'Creates a new App Store version (e.g. 2.1.0) for an app, ready for metadata, a build and review submission. Fails if the platform already has a version in progress.',
  write: true,
  input: z.object({
    appId: id('App', 'list_apps'),
    platform,
    versionString: z.string().min(1).describe('Version number shown on the App Store, e.g. 2.1.0.'),
    releaseType: z
      .enum(['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'])
      .optional()
      .describe('When to release after approval. SCHEDULED needs earliestReleaseDate.'),
    earliestReleaseDate: z
      .string()
      .optional()
      .describe('ISO 8601 date-time for a SCHEDULED release, e.g. 2026-11-01T09:00:00-08:00.'),
    copyright: z.string().optional().describe('Copyright line, e.g. "2026 Example Ltd".'),
  }),
  handler: async (args, context) =>
    single(
      await context.client.post(
        '/v1/appStoreVersions',
        jsonApiBody('appStoreVersions', {
          attributes: {
            platform: args.platform,
            versionString: args.versionString,
            releaseType: args.releaseType,
            earliestReleaseDate: args.earliestReleaseDate,
            copyright: args.copyright,
          },
          relationships: { app: linkage('apps', args.appId) },
        }),
        context.signal,
      ),
    ),
});

const versionLocalizationFields = {
  description: z
    .string()
    .optional()
    .describe('Full App Store description (up to 4000 characters).'),
  keywords: z
    .string()
    .optional()
    .describe('Comma-separated search keywords (up to 100 characters).'),
  whatsNew: z.string().optional().describe("What's New in This Version text (release notes)."),
  promotionalText: z
    .string()
    .optional()
    .describe('Promotional text (up to 170 characters). Can be changed without a new version.'),
  marketingUrl: z.string().optional().describe('Marketing URL.'),
  supportUrl: z.string().optional().describe('Support URL.'),
};

export const updateVersionLocalization = defineTool({
  name: 'update_version_localization',
  title: 'Update version metadata',
  description:
    "Sets an App Store version's metadata for one locale: description, keywords, what's new, promotional text or URLs. Only the fields you pass change. Adds the locale to the version if it isn't there yet.",
  write: true,
  idempotent: true,
  input: z.object({
    versionId: id('App Store version', 'list_app_store_versions'),
    locale,
    ...versionLocalizationFields,
  }),
  handler: async ({ versionId, locale, ...fields }, context) => {
    requireSomeFields(fields, Object.keys(versionLocalizationFields));
    const existing = await context.client.get(
      `/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations`,
      { 'filter[locale]': locale, 'fields[appStoreVersionLocalizations]': 'locale' },
      context.signal,
    );
    const current = resources(existing)[0];
    const document = current
      ? await context.client.patch(
          `/v1/appStoreVersionLocalizations/${encodeURIComponent(current.id)}`,
          jsonApiBody('appStoreVersionLocalizations', { id: current.id, attributes: fields }),
          context.signal,
        )
      : await context.client.post(
          '/v1/appStoreVersionLocalizations',
          jsonApiBody('appStoreVersionLocalizations', {
            attributes: { locale, ...fields },
            relationships: { appStoreVersion: linkage('appStoreVersions', versionId) },
          }),
          context.signal,
        );
    return { action: current ? 'updated' : 'created', localization: single(document) };
  },
});

const appInfoLocalizationFields = {
  name: z.string().optional().describe('App name on the App Store (up to 30 characters).'),
  subtitle: z.string().optional().describe('Subtitle (up to 30 characters).'),
  privacyPolicyUrl: z.string().optional().describe('Privacy policy URL.'),
  privacyChoicesUrl: z.string().optional().describe('Privacy choices URL.'),
};

export const updateAppInfoLocalization = defineTool({
  name: 'update_app_info_localization',
  title: 'Update app name and subtitle',
  description:
    "Sets an app's name, subtitle or privacy URLs for one locale on its editable App Store info record. Only the fields you pass change. Adds the locale if it isn't there yet.",
  write: true,
  idempotent: true,
  input: z.object({
    appId: id('App', 'list_apps'),
    locale,
    appInfoId: z
      .string()
      .optional()
      .describe(
        'Which app info record to edit (from list_app_info_localizations). Defaults to the one that is not live.',
      ),
    ...appInfoLocalizationFields,
  }),
  handler: async ({ appId, locale, appInfoId, ...fields }, context) => {
    requireSomeFields(fields, Object.keys(appInfoLocalizationFields));
    const infos = await appInfosWithLocalizations(context, appId, locale);
    const editable = appInfoId
      ? infos.filter((info) => info.appInfoId === appInfoId)
      : infos.filter(
          (info) =>
            info.state !== 'READY_FOR_DISTRIBUTION' && info.state !== 'REPLACED_WITH_NEW_INFO',
        );
    const target = editable.length === 1 ? editable[0] : infos.length === 1 ? infos[0] : undefined;
    if (!target) {
      throw new Error(
        `Could not choose which app info record to edit. Pass appInfoId, one of: ${infos.map((info) => `${info.appInfoId} (${info.state})`).join(', ')}.`,
      );
    }

    const current = (target.localizations as { id: string }[] | undefined)?.[0];
    const document: JsonApiDocument = current
      ? await context.client.patch(
          `/v1/appInfoLocalizations/${encodeURIComponent(current.id)}`,
          jsonApiBody('appInfoLocalizations', { id: current.id, attributes: fields }),
          context.signal,
        )
      : await context.client.post(
          '/v1/appInfoLocalizations',
          jsonApiBody('appInfoLocalizations', {
            attributes: { locale, ...fields },
            relationships: { appInfo: linkage('appInfos', target.appInfoId) },
          }),
          context.signal,
        );
    return {
      action: current ? 'updated' : 'created',
      appInfoId: target.appInfoId,
      localization: single(document),
    };
  },
});

export const selectBuildForVersion = defineTool({
  name: 'select_build_for_version',
  title: 'Attach build to version',
  description:
    'Attaches a processed build to an App Store version, replacing any build already attached. The build must be VALID and belong to the same app and platform.',
  write: true,
  idempotent: true,
  input: z.object({
    versionId: id('App Store version', 'list_app_store_versions'),
    buildId: id('Build', 'list_builds'),
  }),
  handler: async ({ versionId, buildId }, context) => {
    await context.client.patch(
      `/v1/appStoreVersions/${encodeURIComponent(versionId)}/relationships/build`,
      { data: linkage('builds', buildId) },
      context.signal,
    );
    return { versionId, buildId, attached: true };
  },
});

export const submitForReview = defineTool({
  name: 'submit_for_review',
  title: 'Submit version for App Review',
  description:
    'Submits an App Store version to App Review. The version needs a build attached and complete metadata. Reuses an open review submission for the platform if one exists. Ask the user before calling this.',
  write: true,
  destructive: true,
  input: z.object({
    appId: id('App', 'list_apps'),
    versionId: id('App Store version', 'list_app_store_versions'),
  }),
  handler: async ({ appId, versionId }, context) => {
    const { client, signal } = context;
    const version = single(
      await client.get(
        `/v1/appStoreVersions/${encodeURIComponent(versionId)}`,
        { 'fields[appStoreVersions]': ['platform', 'versionString', 'appVersionState'] },
        signal,
      ),
    );
    const versionPlatform = version.platform as (typeof PLATFORMS)[number];

    const open = await client.get(
      '/v1/reviewSubmissions',
      {
        'filter[app]': appId,
        'filter[platform]': versionPlatform,
        'filter[state]': 'READY_FOR_REVIEW',
        limit: 1,
      },
      signal,
    );
    const submissionId =
      resources(open)[0]?.id ??
      single(
        await client.post(
          '/v1/reviewSubmissions',
          jsonApiBody('reviewSubmissions', {
            attributes: { platform: versionPlatform },
            relationships: { app: linkage('apps', appId) },
          }),
          signal,
        ),
      ).id;

    try {
      await client.post(
        '/v1/reviewSubmissionItems',
        jsonApiBody('reviewSubmissionItems', {
          relationships: {
            reviewSubmission: linkage('reviewSubmissions', submissionId),
            appStoreVersion: linkage('appStoreVersions', versionId),
          },
        }),
        signal,
      );
    } catch (error) {
      // Reusing a submission that already contains this version is fine.
      if (
        !(
          error instanceof ApiError &&
          error.status === 409 &&
          (await submissionContains(context, submissionId, versionId))
        )
      ) {
        throw error;
      }
    }

    const submitted = single(
      await client.patch(
        `/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`,
        jsonApiBody('reviewSubmissions', { id: submissionId, attributes: { submitted: true } }),
        signal,
      ),
    );
    return { submission: submitted, version };
  },
});

async function submissionContains(
  context: ToolContext,
  submissionId: string,
  versionId: string,
): Promise<boolean> {
  const items = await context.client.get(
    `/v1/reviewSubmissions/${encodeURIComponent(submissionId)}/items`,
    { include: 'appStoreVersion', limit: 50 },
    context.signal,
  );
  return resources(items).some((item) => {
    const data = item.relationships?.appStoreVersion?.data;
    return !Array.isArray(data) && data?.id === versionId;
  });
}

export const versionTools = [
  listAppStoreVersions,
  listVersionLocalizations,
  listAppInfoLocalizations,
  createAppStoreVersion,
  updateVersionLocalization,
  updateAppInfoLocalization,
  selectBuildForVersion,
  submitForReview,
];
