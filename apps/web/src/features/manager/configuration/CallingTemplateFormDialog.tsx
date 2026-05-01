// Add / Edit dialog for an Auto Calling template row. Three editable
// fields: calling_name (read-only when editing — it's the doc id),
// auto_kindoo_access (checkbox), give_app_access (checkbox; UI-labeled
// "Can Request Access" — Firestore field name unchanged). Submit label
// is "Add Calling" (add) / "Save Changes" (edit).
//
// Edit-flow uses the existing upsert mutation (sheet_order passes
// through unchanged). Add-flow uses the add mutation (sheet_order
// computed as max+1 from `existing`).

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { WardCallingTemplate } from '@kindoo/shared';
import { callingTemplateSchema, type CallingTemplateForm } from './schemas';
import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Input } from '../../../components/ui/Input';
import { toast } from '../../../lib/store/toast';

export type CallingTemplateDialogMode =
  | 'closed'
  | 'add'
  | { kind: 'edit'; template: WardCallingTemplate };

export interface CallingTemplateFormDialogProps {
  mode: CallingTemplateDialogMode;
  isPending: boolean;
  testid: string;
  onSubmitAdd: (input: CallingTemplateForm) => Promise<void>;
  onSubmitEdit: (input: CallingTemplateForm) => Promise<void>;
  onClose: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function CallingTemplateFormDialog({
  mode,
  isPending,
  testid,
  onSubmitAdd,
  onSubmitEdit,
  onClose,
}: CallingTemplateFormDialogProps) {
  const isEdit = typeof mode === 'object' && mode.kind === 'edit';
  const editingTemplate = isEdit ? mode.template : null;
  const open = mode !== 'closed';

  const form = useForm<CallingTemplateForm>({
    resolver: zodResolver(callingTemplateSchema),
    defaultValues: editingTemplate
      ? {
          calling_name: editingTemplate.calling_name,
          give_app_access: editingTemplate.give_app_access,
          auto_kindoo_access: editingTemplate.auto_kindoo_access ?? false,
          sheet_order: editingTemplate.sheet_order,
        }
      : {
          calling_name: '',
          give_app_access: false,
          auto_kindoo_access: false,
          sheet_order: 0,
        },
  });
  const { register, handleSubmit, reset, formState } = form;

  useEffect(() => {
    if (!open) return;
    reset(
      editingTemplate
        ? {
            calling_name: editingTemplate.calling_name,
            give_app_access: editingTemplate.give_app_access,
            auto_kindoo_access: editingTemplate.auto_kindoo_access ?? false,
            sheet_order: editingTemplate.sheet_order,
          }
        : {
            calling_name: '',
            give_app_access: false,
            auto_kindoo_access: false,
            sheet_order: 0,
          },
    );
  }, [open, editingTemplate, reset]);

  const submit = handleSubmit(async (input) => {
    try {
      if (isEdit) await onSubmitEdit(input);
      else await onSubmitAdd(input);
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={isEdit ? `Edit calling — ${editingTemplate?.calling_name ?? ''}` : 'Add calling'}
    >
      <form onSubmit={submit} className="kd-wizard-form" data-testid={`config-${testid}-form`}>
        <label>
          Calling name
          <Input
            {...register('calling_name')}
            placeholder="Bishop or Counselor *"
            readOnly={isEdit}
            aria-readonly={isEdit}
          />
        </label>
        {formState.errors.calling_name ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.calling_name.message}
          </p>
        ) : null}
        <label>
          <input type="checkbox" {...register('auto_kindoo_access')} /> Auto Kindoo Access
        </label>
        <label>
          <input type="checkbox" {...register('give_app_access')} /> Can Request Access
        </label>
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Button type="submit" disabled={isPending} data-testid={`config-${testid}-submit`}>
            {isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Calling'}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}
