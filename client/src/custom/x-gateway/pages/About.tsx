import { Info } from 'lucide-react'
import { useCustomT } from '@/custom/i18n/use-custom-t'
import { AboutContent } from '../../about/AboutContent'

export default function About() {
  const tc = useCustomT()

  return (
    <div className="x-page space-y-6 max-w-5xl">
      <div className="x-page-heading">
        <div>
          <h1>{tc('About FreeLLMAPI')}</h1>
          <p>{tc('Version, source repository, and active deployment links.')}</p>
        </div>
        <span className="x-heading-icon"><Info size={28} /></span>
      </div>
      <AboutContent />
    </div>
  )
}
