import { LoaderCircle, Server } from 'lucide-react'
import { useXStrings } from '../strings'

export function AccountLoadState({ error, retry }: { error?: boolean; retry?: () => void }) {
  const s = useXStrings()
  return <div className="x-empty" role={error ? 'alert' : 'status'}>{error ? <Server size={32} /> : <LoaderCircle size={30} className="x-spin" />}<p>{error ? s.loadError : s.loading}</p>{error && <button className="x-button" onClick={retry}>{s.retry}</button>}</div>
}
