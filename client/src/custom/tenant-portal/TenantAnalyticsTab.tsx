import { useQuery } from '@tanstack/react-query';
import { BarChart3, History, Star } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useCustomT } from '../i18n/use-custom-t';
import { tenantPortalApi } from './api';

export function TenantAnalyticsTab({ tenantId }: { tenantId: number }) {
  const tc = useCustomT();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tenant-portal-analytics', tenantId],
    queryFn: () => tenantPortalApi.getAnalytics(tenantId),
  });

  if (isLoading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{tc('Loading tenant analytics…')}</p>;
  }
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error instanceof Error ? error.message : tc('Could not load tenant analytics.')}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <CardDescription>{tc('Total conversations')}</CardDescription>
            <CardTitle className="text-2xl">{data.analytics.totalConversations}</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>{tc('AI deflection rate')}</CardDescription>
            <CardTitle className="text-2xl">{data.analytics.deflectionRatePct}%</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>{tc('Open tickets')}</CardDescription>
            <CardTitle className="text-2xl">{data.analytics.openTickets}</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>{tc('CSAT average')}</CardDescription>
            <CardTitle className="flex items-center gap-1.5 text-2xl">
              <Star className="size-4 text-amber-500" />
              {data.csatSummary.averageScore} / 5
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="size-4" />
              {tc('Recent CSAT Feedback ({count})', { count: data.csatRatings.length })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.csatRatings.length === 0 ? (
              <p className="text-xs text-muted-foreground">{tc('No CSAT ratings recorded yet.')}</p>
            ) : (
              <div className="divide-y rounded-xl border text-xs">
                {data.csatRatings.slice(0, 15).map((r) => (
                  <div key={r.id} className="flex items-start justify-between gap-3 p-2.5">
                    <div>
                      <div className="font-medium">
                        {r.userId} ({r.userRole})
                      </div>
                      {r.comment && <p className="text-muted-foreground">{r.comment}</p>}
                    </div>
                    <span className="font-semibold">{r.score}/5</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="size-4" />
              {tc('Tenant Change History ({count})', { count: data.auditLogs.length })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.auditLogs.length === 0 ? (
              <p className="text-xs text-muted-foreground">{tc('No audit entries for this tenant yet.')}</p>
            ) : (
              <div className="max-h-72 divide-y overflow-y-auto rounded-xl border text-xs">
                {data.auditLogs.map((log) => (
                  <div key={log.id} className="p-2.5 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-medium">{log.action}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(log.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {tc('Actor: {actor}', { actor: log.userId ?? 'system' })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
