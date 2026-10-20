import { useQuery } from '@tanstack/react-query';

import { ProxyClient } from '../../api/proxy';

export interface AuditFilters {
  itemId?: string;
  action?: string;
  since?: string;
  limit?: number;
}

/** Server audit log (all devices) — the source of truth for recent stock changes. */
export function useAudit(filters: AuditFilters) {
  return useQuery({
    queryKey: ['remote', 'audit', filters],
    queryFn: () => ProxyClient.audit({ limit: 50, ...filters }),
  });
}
