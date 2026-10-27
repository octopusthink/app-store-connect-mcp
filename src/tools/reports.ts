import * as z from 'zod';
import { ENV } from '../config.ts';
import { defineTool, type ToolContext } from './define.ts';
import { formatReport } from './shared.ts';

const vendorNumber = z
  .string()
  .min(1)
  .optional()
  .describe(
    `Vendor number, shown in App Store Connect under Payments and Financial Reports (top left). Omit it to use the one configured in ${ENV.vendorNumber}.`,
  );

/** The vendor number passed to the tool, or the configured default. */
function resolveVendorNumber(given: string | undefined, context: ToolContext): string {
  const vendor = given ?? context.vendorNumber;
  if (!vendor) {
    throw new Error(
      `No vendor number. Pass vendorNumber, or set ${ENV.vendorNumber} in this MCP server's configuration. It's shown in App Store Connect under Payments and Financial Reports.`,
    );
  }
  return vendor;
}

const maxRows = z
  .number()
  .int()
  .min(1)
  .max(5000)
  .default(200)
  .describe('Maximum report rows to return.');

const REPORT_ACCEPT = 'application/a-gzip';

export const getSalesReport = defineTool({
  name: 'get_sales_report',
  title: 'Get sales report',
  description:
    'Downloads a Sales and Trends report (units, proceeds, subscriptions) as tab-separated text. Daily reports are usually available the following day. Needs an API key with the Finance or Sales role.',
  input: z.object({
    vendorNumber,
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']).default('DAILY'),
    reportDate: z
      .string()
      .optional()
      .describe(
        'Report date: YYYY-MM-DD for DAILY and WEEKLY (week ending Sunday), YYYY-MM for MONTHLY, YYYY for YEARLY. Defaults to the latest available.',
      ),
    reportType: z
      .enum([
        'SALES',
        'PRE_ORDER',
        'NEWSSTAND',
        'SUBSCRIPTION',
        'SUBSCRIPTION_EVENT',
        'SUBSCRIBER',
        'SUBSCRIPTION_OFFER_CODE_REDEMPTION',
        'INSTALLS',
        'FIRST_ANNUAL',
        'WIN_BACK_ELIGIBILITY',
      ])
      .default('SALES'),
    reportSubType: z
      .enum(['SUMMARY', 'DETAILED', 'SUMMARY_INSTALL_TYPE', 'SUMMARY_TERRITORY', 'SUMMARY_CHANNEL'])
      .default('SUMMARY'),
    version: z
      .string()
      .optional()
      .describe(
        'Report format version, e.g. 1_0 or 1_3. Some report types require a specific version.',
      ),
    maxRows,
  }),
  handler: async (args, context) => {
    const response = await context.client.request<string>({
      path: '/v1/salesReports',
      accept: REPORT_ACCEPT,
      query: {
        'filter[vendorNumber]': resolveVendorNumber(args.vendorNumber, context),
        'filter[frequency]': args.frequency,
        'filter[reportType]': args.reportType,
        'filter[reportSubType]': args.reportSubType,
        'filter[reportDate]': args.reportDate,
        'filter[version]': args.version,
      },
      signal: context.signal,
    });
    return formatReport(String(response.data ?? ''), args.maxRows);
  },
});

export const getFinanceReport = defineTool({
  name: 'get_finance_report',
  title: 'Get finance report',
  description:
    'Downloads a monthly financial report (earnings by region and currency) as tab-separated text. Needs an API key with the Finance role.',
  input: z.object({
    vendorNumber,
    reportDate: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .describe("Fiscal month as YYYY-MM, e.g. 2026-09 (Apple's fiscal calendar)."),
    reportType: z
      .enum(['FINANCIAL', 'FINANCE_DETAIL'])
      .default('FINANCIAL')
      .describe(
        'FINANCIAL: per-region summary. FINANCE_DETAIL: all regions in detail (use regionCode Z1).',
      ),
    regionCode: z
      .string()
      .default('ZZ')
      .describe(
        'Region code: ZZ for all regions consolidated (FINANCIAL), Z1 for FINANCE_DETAIL, or a code such as US or EU.',
      ),
    maxRows,
  }),
  handler: async (args, context) => {
    const response = await context.client.request<string>({
      path: '/v1/financeReports',
      accept: REPORT_ACCEPT,
      query: {
        'filter[vendorNumber]': resolveVendorNumber(args.vendorNumber, context),
        'filter[reportType]': args.reportType,
        'filter[regionCode]': args.regionCode,
        'filter[reportDate]': args.reportDate,
      },
      signal: context.signal,
    });
    return formatReport(String(response.data ?? ''), args.maxRows);
  },
});

export const reportTools = [getSalesReport, getFinanceReport];
