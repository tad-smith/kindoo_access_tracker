// Sortable table for the Auto Ward Callings + Auto Stake Callings
// tabs. Three columns: Calling Name, Auto Kindoo Access, Can Request
// Access. Per-row actions on the right (Edit, Delete).
//
// Drag-to-reorder via @dnd-kit. PointerSensor + KeyboardSensor only —
// TouchSensor is intentionally NOT registered. Touch goes through the
// per-row long-press path: a 500ms hold reveals up/down arrow buttons
// inline, plus a Done button to dismiss the reorder mode. Outside-tap
// also dismisses.
//
// Reorder writes are optimistic: the table renders the dragged order
// immediately, the parent's `onReorder` mutation commits, and on
// failure the parent toasts and the live snapshot listener restores
// truth. This component does not own Firestore I/O — the parent does.

import { useState, useEffect, useMemo, useRef } from 'react';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripHorizontal } from 'lucide-react';
import type { WardCallingTemplate } from '@kindoo/shared';
import { Button } from '../../../components/ui/Button';
import { useLongPress } from '../../../lib/useLongPress';

export interface CallingTemplatesTableProps {
  testid: string;
  templates: ReadonlyArray<WardCallingTemplate>;
  onEdit: (template: WardCallingTemplate) => void;
  onDelete: (template: WardCallingTemplate) => void;
  onReorder: (orderedCallingNames: string[]) => void;
}

export function CallingTemplatesTable({
  testid,
  templates,
  onEdit,
  onDelete,
  onReorder,
}: CallingTemplatesTableProps) {
  // Local order mirror — lets us render the optimistic order during
  // drag and after a successful commit without waiting for the live
  // snapshot. Resets when the live `templates` prop changes.
  const sortedFromProps = useMemo(
    () => [...templates].sort((a, b) => a.sheet_order - b.sheet_order),
    [templates],
  );
  const [order, setOrder] = useState<WardCallingTemplate[]>(sortedFromProps);
  useEffect(() => {
    setOrder(sortedFromProps);
  }, [sortedFromProps]);

  const [touchReorderId, setTouchReorderId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = order.findIndex((t) => t.calling_name === active.id);
    const newIndex = order.findIndex((t) => t.calling_name === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(order, oldIndex, newIndex);
    setOrder(next);
    onReorder(next.map((t) => t.calling_name));
  };

  const moveBy = (callingName: string, delta: number) => {
    const idx = order.findIndex((t) => t.calling_name === callingName);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= order.length) return;
    const next = arrayMove(order, idx, target);
    setOrder(next);
    onReorder(next.map((t) => t.calling_name));
  };

  // Tap-elsewhere dismissal. Listen on document; ignore taps inside
  // the table container (so tapping the arrows doesn't dismiss).
  const tableRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!touchReorderId) return;
    const handler = (event: PointerEvent) => {
      const root = tableRef.current;
      if (!root) return;
      if (root.contains(event.target as Node)) return;
      setTouchReorderId(null);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [touchReorderId]);

  return (
    <div className="kd-callings-table-wrap" ref={tableRef} data-testid={`config-${testid}-table`}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <table className="kd-callings-table">
          <thead>
            <tr>
              <th className="kd-callings-table-col-grip" aria-hidden="true" />
              <th>Calling Name</th>
              <th>Auto Kindoo Access</th>
              <th>Can Request Access</th>
              <th className="kd-callings-table-col-actions" aria-label="Actions" />
            </tr>
          </thead>
          <SortableContext
            items={order.map((t) => t.calling_name)}
            strategy={verticalListSortingStrategy}
          >
            <tbody>
              {order.map((t, i) => (
                <SortableRow
                  key={t.calling_name}
                  template={t}
                  testid={testid}
                  isFirst={i === 0}
                  isLast={i === order.length - 1}
                  inTouchReorder={touchReorderId === t.calling_name}
                  onLongPress={() => setTouchReorderId(t.calling_name)}
                  onDoneTouchReorder={() => setTouchReorderId(null)}
                  onMoveUp={() => moveBy(t.calling_name, -1)}
                  onMoveDown={() => moveBy(t.calling_name, 1)}
                  onEdit={() => onEdit(t)}
                  onDelete={() => onDelete(t)}
                />
              ))}
            </tbody>
          </SortableContext>
        </table>
      </DndContext>
    </div>
  );
}

interface SortableRowProps {
  template: WardCallingTemplate;
  testid: string;
  isFirst: boolean;
  isLast: boolean;
  inTouchReorder: boolean;
  onLongPress: () => void;
  onDoneTouchReorder: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function SortableRow({
  template,
  testid,
  isFirst,
  isLast,
  inTouchReorder,
  onLongPress,
  onDoneTouchReorder,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
}: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: template.calling_name,
  });

  const longPress = useLongPress({ onLongPress });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={`kd-callings-row${inTouchReorder ? ' touch-reorder' : ''}`}
      data-testid={`config-${testid}-row-${template.calling_name}`}
      onPointerDown={longPress.onPointerDown}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
      onPointerLeave={longPress.onPointerLeave}
    >
      <td className="kd-callings-table-col-grip">
        <button
          type="button"
          className="kd-callings-grip"
          aria-label={`Drag to reorder ${template.calling_name}`}
          data-testid={`config-${testid}-grip-${template.calling_name}`}
          {...attributes}
          {...listeners}
        >
          <GripHorizontal size={16} aria-hidden="true" />
        </button>
      </td>
      <td className="kd-callings-table-col-name">
        <code>{template.calling_name}</code>
      </td>
      <td className="kd-callings-table-col-flag">
        <input
          type="checkbox"
          checked={template.auto_kindoo_access ?? false}
          readOnly
          aria-label={`Auto Kindoo Access — ${template.calling_name}`}
        />
      </td>
      <td className="kd-callings-table-col-flag">
        <input
          type="checkbox"
          checked={template.give_app_access}
          readOnly
          aria-label={`Can Request Access — ${template.calling_name}`}
        />
      </td>
      <td className="kd-callings-table-col-actions">
        {inTouchReorder ? (
          <span className="kd-callings-row-arrows">
            <Button
              variant="secondary"
              onClick={onMoveUp}
              disabled={isFirst}
              aria-label={`Move ${template.calling_name} up`}
              data-testid={`config-${testid}-up-${template.calling_name}`}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </Button>
            <Button
              variant="secondary"
              onClick={onMoveDown}
              disabled={isLast}
              aria-label={`Move ${template.calling_name} down`}
              data-testid={`config-${testid}-down-${template.calling_name}`}
            >
              <ArrowDown size={16} aria-hidden="true" />
            </Button>
            <Button
              variant="secondary"
              onClick={onDoneTouchReorder}
              data-testid={`config-${testid}-done-${template.calling_name}`}
            >
              Done
            </Button>
          </span>
        ) : (
          <span className="kd-callings-row-actions">
            <Button
              variant="secondary"
              onClick={onEdit}
              data-testid={`config-${testid}-edit-${template.calling_name}`}
            >
              Edit
            </Button>
            <Button
              variant="danger"
              onClick={onDelete}
              data-testid={`config-${testid}-delete-${template.calling_name}`}
            >
              Delete
            </Button>
          </span>
        )}
      </td>
    </tr>
  );
}
