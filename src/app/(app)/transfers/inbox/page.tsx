import { redirect } from 'next/navigation';

/** Now a view of the Transfer register; kept so old links and bookmarks still work. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const u = new URLSearchParams({ view: 'inbound' });
  for (const [key, v] of Object.entries(await searchParams)) for (const x of [v ?? []].flat()) u.append(key, x);
  redirect(`/transfers?${u}`);
}
