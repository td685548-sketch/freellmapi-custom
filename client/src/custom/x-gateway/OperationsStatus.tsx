import { useI18n } from '@/i18n';
import { useGatewayDiagnostics } from './operations-api';
export function OperationsStatus({ revision }: { revision: number }) {
  const { locale } = useI18n();
  const vi = locale === 'vi';
  const query = useGatewayDiagnostics(revision);
  const labels = vi ? { configured: 'Đã cấu hình', ready: 'Đã kiểm chứng', unavailable: 'Không khả dụng', unverified: 'Chưa kiểm chứng' }
    : { configured: 'Configured', ready: 'Verified', unavailable: 'Unavailable', unverified: 'Unverified' };
  return <section className="x-panel" style={{ padding: 18 }} aria-label="Gateway diagnostics">
    <h2>{vi ? 'Khả dụng & kiểm chứng' : 'Availability & verification'}</h2>
    <p>{vi ? 'Bằng chứng chỉ có hiệu lực 5 phút trong phiên này. Test có dùng quota của provider.' : 'Evidence lasts five minutes in this session. Tests consume provider quota.'}</p>
    {query.isPending && <p>{vi ? 'Đang kiểm tra…' : 'Loading diagnostics…'}</p>}
    {query.isError && <p role="alert">{vi ? 'Không tải được diagnostics.' : 'Diagnostics could not be loaded.'}</p>}
    {query.data && <>
      <div className="x-table-wrap"><table className="x-table"><thead><tr><th>Capability</th><th>Status</th><th>Evidence / limits</th></tr></thead>
        <tbody>{query.data.capabilities.map(c => <tr key={c.id}><th>{c.id}</th><td>{labels[c.state]}</td>
          <td style={{ whiteSpace: 'normal' }}>{c.detail}{c.model && <div><code>{c.model}</code> · {c.checkedAt && new Date(c.checkedAt).toLocaleTimeString()}</div>}</td></tr>)}</tbody></table></div>
      <p>DB: {query.data.deployment.database} · Persistence: {query.data.deployment.persistence}</p>
      <p>{vi ? 'Public URL được cấu hình' : 'Public URL configured'}: {String(query.data.deployment.publicBaseConfigured)} · ENCRYPTION_KEY: {query.data.deployment.encryptionKeyConfigured ? 'configured' : 'missing/invalid'}</p>
    </>}
    <button className="x-button x-small" onClick={() => void query.refetch()} disabled={query.isFetching}>{vi ? 'Kiểm tra lại cấu hình' : 'Refresh configuration'}</button>
  </section>;
}
