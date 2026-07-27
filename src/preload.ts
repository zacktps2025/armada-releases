import { contextBridge, ipcRenderer } from 'electron'

/**
 * The only surface the launcher page can reach.
 *
 * Context isolation is on and node integration is off, so this list is
 * exhaustive by construction: five calls and two events. The launcher is local
 * HTML we wrote, but the game window loads a remote origin, and the rule that
 * keeps that safe is that neither of them is ever handed a raw `require`.
 */
export interface ArmadaBridge {
  version(): Promise<string>
  status(): Promise<{ online: boolean; players?: number; tick?: number }>
  play(): Promise<void>
  quit(): Promise<void>
  signOut(): Promise<boolean>
  onOffline(handler: (detail: { description: string; url: string }) => void): void
  onUpdateReady(handler: (detail: { version: string }) => void): void
}

const bridge: ArmadaBridge = {
  version: () => ipcRenderer.invoke('armada:version'),
  status: () => ipcRenderer.invoke('armada:status'),
  play: () => ipcRenderer.invoke('armada:play'),
  quit: () => ipcRenderer.invoke('armada:quit'),
  signOut: () => ipcRenderer.invoke('armada:signOut'),
  onOffline: (handler) => {
    ipcRenderer.on('armada:offline', (_event, detail) => handler(detail))
  },
  onUpdateReady: (handler) => {
    ipcRenderer.on('armada:updateReady', (_event, detail) => handler(detail))
  },
}

contextBridge.exposeInMainWorld('armada', bridge)
