export type TunnelState = 'stopped' | 'starting' | 'active' | 'error';

export interface TunnelStatus {
  state: TunnelState;
  url: string | null;
  port: number;
  startedAt: number | null;
  uptimeSeconds: number;
  cloudflaredInstalled: boolean;
  cloudflaredPath: string | null;
  error: string | null;
  logTail: string[];
  metrics: {
    reconnectCount: number;
  };
}
