import type { Request } from "express";

export type Pagination = {
  page: number;
  limit: number;
  offset: number;
};

export type PaginationMeta = {
  page: number;
  limit: number;
  totalCount: number;
  hasMore: boolean;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export function parsePagination(
  query: Request["query"] | Record<string, unknown>,
  defaults: { page?: number; limit?: number } = {},
): Pagination {
  const defaultPage = defaults.page ?? 1;
  const defaultLimit = defaults.limit ?? DEFAULT_LIMIT;

  const rawPage = Number.parseInt(String(query.page ?? defaultPage), 10);
  const rawLimit = Number.parseInt(String(query.limit ?? defaultLimit), 10);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : defaultPage;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, rawLimit))
    : defaultLimit;
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

export function paginationMeta(
  page: number,
  limit: number,
  totalCount: number,
): PaginationMeta {
  const safeTotal = Math.max(0, totalCount || 0);
  return {
    page,
    limit,
    totalCount: safeTotal,
    hasMore: page * limit < safeTotal,
  };
}
