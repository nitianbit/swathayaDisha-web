import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import type { Page } from '@jansetu/api';

/**
 * A list read page by page until the server's reported total is exhausted (the per-request size limit is not a
 * history limit). Pages are appended in order.
 */
export function usePagedList<T>(queryKey: QueryKey, fetchPage: (page: number) => Promise<Page<T>>) {
  const q = useInfiniteQuery({
    queryKey,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total ?? 0;
  return { q, items, total };
}
