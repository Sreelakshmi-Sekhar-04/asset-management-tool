import { redirect } from 'next/navigation';

/** The old "choose how to add" page: Create asset now has Manual and Excel Upload tabs. */
export default function WaysToRegister() { redirect('/assets/new'); }
