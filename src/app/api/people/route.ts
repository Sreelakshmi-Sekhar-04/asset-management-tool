import { route, paging, q } from '@/server/http';
import { listPeople } from '@/server/services/people';

export const GET = route({}, async ({ actor, url }) => {
  const p = paging(url);
  return listPeople(actor, {
    name: q(url, 'name'), employeeCode: q(url, 'employeeCode'), departmentId: q(url, 'departmentId'), locationId: q(url, 'locationId'),
    signIn: q(url, 'signIn'), active: q(url, 'active'), holding: q(url, 'holding'), sort: p.sort, dir: p.dir, skip: p.skip, take: p.take,
  });
});
