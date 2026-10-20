import { Text, View } from 'react-native';

import type { AuditEntry } from '../../api/schemas';
import { Badge, type BadgeTone } from '../../components';

const ACTION: Record<string, string> = { receive: 'Receive', count: 'Count', adjust: 'Adjust', undo: 'Undo' };
const REASON: Record<string, string> = {
  damaged: 'Damaged',
  expired: 'Expired',
  theft_loss: 'Theft/Loss',
  correction: 'Correction',
  other: 'Other',
};
const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  applied: { label: 'Applied', tone: 'success' },
  conflict: { label: 'Conflict', tone: 'warning' },
  rejected: { label: 'Rejected', tone: 'danger' },
  unknown: { label: 'Unknown', tone: 'danger' },
};

export class AuditFormat {
  static change(e: Pick<AuditEntry, 'beforeQty' | 'afterQty' | 'status'>): string {
    const b = e.beforeQty ?? '—';
    if (e.status === 'conflict') return `${b} (live) · not applied`;
    return `${b} → ${e.afterQty ?? '—'}`;
  }

  static time(iso: string, now = Date.now()): string {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const mins = Math.floor((now - t) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    if (mins < 24 * 60) return `${Math.floor(mins / 60)} h ago`;
    return new Date(t).toLocaleDateString();
  }

  static status(s: string): { label: string; tone: BadgeTone } {
    return STATUS[s] ?? { label: s, tone: 'neutral' };
  }
}

export function AuditRow({ entry, showItem = true }: { entry: AuditEntry; showItem?: boolean }) {
  const status = AuditFormat.status(entry.status);
  const detail = [ACTION[entry.action] ?? entry.action, entry.reason ? REASON[entry.reason] ?? entry.reason : null, entry.note]
    .filter(Boolean)
    .join(' · ');
  return (
    <View className="min-h-primary flex-row items-center gap-3 border-b border-border bg-surface px-4 py-3">
      <View className="flex-1 gap-0.5">
        {showItem ? (
          <Text className="text-base font-medium text-text" numberOfLines={1}>
            {entry.itemName ?? entry.itemId}
          </Text>
        ) : null}
        <Text className="text-base text-text" style={{ fontVariant: ['tabular-nums'] }}>
          {AuditFormat.change(entry)}
        </Text>
        <Text className="text-sm text-text-muted" numberOfLines={2}>
          {detail} · {entry.deviceName ?? 'Unknown device'} · {AuditFormat.time(entry.createdAt)}
        </Text>
      </View>
      <Badge label={status.label} tone={status.tone} />
    </View>
  );
}
