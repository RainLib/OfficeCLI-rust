import { useI18n } from './i18n.tsx'
import { localizeDynamic, localizeSource } from './sourceLocale.tsx'
export function ErrorToast({ message, onClose }: { message: string; onClose: () => void }) {
  const { locale } = useI18n()
  return <div className="toast error" role="alert">
    <span className="toast-message">{localizeDynamic(locale, message)}</span>
    <button className="toast-dismiss" type="button" aria-label={localizeSource(locale, "关闭错误提示")} onClick={onClose}>×</button>
  </div>
}
