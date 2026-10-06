import { RegisterOptions } from '@/components/register-options';
import { PageHeader } from '@/components/ui';

/** The same two choices as the "Register asset" button. */
export default function WaysToRegister() {
  return (
    <div className="max-w-4xl">
      <PageHeader title="Register asset" subtitle="Choose how to add. Both assign the Asset ID on save and run the same duplicate checks." back={{ href: '/assets', label: 'Asset register' }} />
      <RegisterOptions />
    </div>
  );
}
