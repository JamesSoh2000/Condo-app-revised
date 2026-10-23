import { useEffect, useRef, useState } from 'react';

import { serverFieldErrors } from '@/features/auth/formErrors';
import { unitName } from '@/features/onboarding/api';
import type { Package } from '@/features/packages/api';
import { PackageDialog, textError, textMessages, usePackageSubmit } from '@/features/packages/PackageDialog';
import { ReasonField } from '@/features/residents/reason';

const MAX = 300;
const EMPTY = 'Give a reason.';

/**
 * Send a waiting package back to the carrier, with a reason (P5-03d criterion 3). The reason isn't shown anywhere yet
 * (`PackageOut` doesn't return it; the ticket's "Out").
 */
export function ReturnDialog({ item, onClose }: { item: Package; onClose: (message: string | null) => void }) {
  const { root, busy, failure, submit } = usePackageSubmit(onClose, 'Could not record the return. Try again.');
  const field = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  useEffect(() => field.current?.focus(), []);

  const confirm = () => {
    if (busy) return;
    const invalid = textError(reason, MAX, EMPTY);
    setFieldError(invalid);
    if (invalid) return field.current?.focus();
    const done = `Unit ${unitName(item.unit_tower, item.unit_label)}’s package was marked returned.`;
    void submit({ kind: 'return', id: item.id, reason: reason.trim() }, done, (error) => {
      const placed = serverFieldErrors(error, ['reason'], { reason: textMessages(MAX, EMPTY) });
      if (!placed) return false;
      setFieldError(placed[0].message);
      field.current?.focus();
      return true;
    });
  };

  return (
    <PackageDialog
      title="Return this package to the carrier?"
      item={item}
      confirm="Return"
      busy={busy}
      failure={failure}
      dialogRef={root}
      onConfirm={confirm}
      onCancel={() => onClose(null)}
    >
      <ReasonField
        label="Reason"
        value={reason}
        error={fieldError}
        busy={busy}
        fieldRef={field}
        maxLength={2 * MAX}
        onChange={(value) => {
          setReason(value);
          setFieldError(null);
        }}
      />
    </PackageDialog>
  );
}
