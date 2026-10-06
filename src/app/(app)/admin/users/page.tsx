import { redirect } from 'next/navigation';

/** Users and employees are managed on one page now; sign-in accounts show there for Administrators. */
export default function UsersPage() {
  redirect('/employees?signIn=ANY');
}
