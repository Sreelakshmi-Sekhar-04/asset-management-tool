import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '@/lib/paging';
import { paging } from '@/server/http';

describe('default page size', () => {
  it('is 10 rows and the first choice in the selector', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(10);
    expect(PAGE_SIZE_OPTIONS[0]).toBe(10);
  });
  it('applies to API lists that do not ask for a size', () => {
    expect(paging(new URL('http://x/api/assets'))).toMatchObject({ page: 1, pageSize: 10, take: 10, skip: 0 });
    expect(paging(new URL('http://x/api/assets?page=3'))).toMatchObject({ pageSize: 10, skip: 20 });
    expect(paging(new URL('http://x/api/assets?pageSize=abc'))).toMatchObject({ pageSize: 10 });
    expect(paging(new URL('http://x/api/assets?pageSize=50'))).toMatchObject({ pageSize: 50 });
  });
});
