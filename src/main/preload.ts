import { contextBridge, ipcRenderer } from 'electron';
import type { TaskSprigAPI, VoiceStreamEvent } from '../shared/types';
const api: TaskSprigAPI = {
  snapshot: () => ipcRenderer.invoke('tasksprig:snapshot'),
  act: action => ipcRenderer.invoke('tasksprig:act', action),
  chat: (text, activeListId) => ipcRenderer.invoke('tasksprig:chat', text, activeListId),
  requestMicrophoneAccess: () => ipcRenderer.invoke('tasksprig:microphone-access'),
  transcribeAudio: request => ipcRenderer.invoke('tasksprig:transcribe', request),
  startVoiceStream: () => ipcRenderer.invoke('tasksprig:voice-start'),
  pushVoiceAudio: chunk => ipcRenderer.invoke('tasksprig:voice-audio', chunk),
  stopVoiceStream: request => ipcRenderer.invoke('tasksprig:voice-stop', request),
  onVoiceStreamEvent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, event: VoiceStreamEvent) => callback(event);
    ipcRenderer.on('tasksprig:voice-event', listener);
    return () => { ipcRenderer.removeListener('tasksprig:voice-event', listener); };
  },
  setClock: iso => ipcRenderer.invoke('tasksprig:clock', iso),
  resetDemo: () => ipcRenderer.invoke('tasksprig:reset'),
  settings: () => ipcRenderer.invoke('tasksprig:settings'),
  saveSettings: settings => ipcRenderer.invoke('tasksprig:save-settings', settings),
  onChange: callback => {
    const listener = () => callback();
    ipcRenderer.on('tasksprig:changed', listener);
    return () => { ipcRenderer.removeListener('tasksprig:changed', listener); };
  },
};
contextBridge.exposeInMainWorld('tasksprig', api);
