import { RegisterOptions } from '@/components/register-options';
import { PageHeader } from '@/components/ui';

/** Every way to put assets into the register (the same choices as the "Register asset" button). */
export default function WaysToRegister() {
  return (
    <div className="max-w-4xl">
      <PageHeader title="Register asset" subtitle="Every method assigns the Asset ID on save and runs the same duplicate checks." back={{ href: '/assets', label: 'Asset register' }} />
      <RegisterOptions />
    </div>
  );
}
