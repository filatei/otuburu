'use client'
import { useState } from 'react'
import type { AuthUser } from '@/hooks/useAuth'

interface Props {
  user: AuthUser
  onClose: () => void
}

export default function ProfileModal({ user, onClose }: Props) {
  const [displayName, setDisplayName] = useState(user.name ?? '')
  const [saved, setSaved] = useState(false)

  const handleSave = () => {
    // Display name preference stored locally — backend update can be wired later
    sessionStorage.setItem('otuburu_display_name', displayName)
    setSaved(true)
    setTimeout(() => { setSaved(false); onClose() }, 1200)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div className="bg-panel border border-border rounded-2xl p-6 flex flex-col gap-5 w-full max-w-sm shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-text font-semibold text-base">Edit Profile</h2>
          <button onClick={onClose} className="text-dim hover:text-text transition-colors text-lg leading-none">✕</button>
        </div>

        {/* Avatar */}
        <div className="flex flex-col items-center gap-3">
          {user.picture ? (
            <img src={user.picture} alt={user.name} className="w-20 h-20 rounded-full border-2 border-brand" referrerPolicy="no-referrer" />
          ) : (
            <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center text-2xl text-text font-bold">
              {user.name?.[0]?.toUpperCase() ?? '?'}
            </div>
          )}
          <p className="text-dim text-xs">Profile photo managed by Google</p>
        </div>

        <div className="w-full h-px bg-border" />

        {/* Fields */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] text-dim uppercase tracking-wider">Display Name</label>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className="bg-surface border border-border rounded-lg px-3 py-2.5 text-sm text-text focus:outline-none focus:border-brand transition-colors"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] text-dim uppercase tracking-wider">Email</label>
            <div className="bg-surface border border-border/50 rounded-lg px-3 py-2.5 text-sm text-dim cursor-not-allowed">
              {user.email}
            </div>
            <p className="text-[10px] text-dim">Email is managed by Google and cannot be changed here.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] text-dim uppercase tracking-wider">Account ID</label>
            <div className="bg-surface border border-border/50 rounded-lg px-3 py-2 flex items-center justify-between">
              <span className="num text-xs text-dim truncate">{user.user_id}</span>
              <button
                onClick={() => navigator.clipboard.writeText(user.user_id)}
                className="text-dim hover:text-text text-xs ml-2 shrink-0"
              >
                Copy
              </button>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg border border-border text-dim text-sm hover:text-text hover:border-border/80 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
              saved
                ? 'bg-up/20 text-up border border-up/30'
                : 'bg-brand text-white hover:bg-brand/90 border border-brand'
            }`}
          >
            {saved ? '✓ Saved' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
