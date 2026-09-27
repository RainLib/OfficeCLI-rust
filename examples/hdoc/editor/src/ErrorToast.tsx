export function ErrorToast({ message, onClose }: { message: string; onClose: () => void }) {
  return <div className="toast error" role="alert">
    <span className="toast-message">{message}</span>
    <button className="toast-dismiss" type="button" aria-label="关闭错误提示" onClick={onClose}>×</button>
  </div>
}
