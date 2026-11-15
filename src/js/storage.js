// UI working copy only. The authoritative library lives in Supabase.
// No voices, library contents or credentials are persisted in localStorage.
const copy = value => JSON.parse(JSON.stringify(value));
const DEFAULT_SETTINGS = { showQuickFolderBadge: false, showSidebarFolders: true, showNotes: true };
let memory = { folders: null, voices: null, settings: copy(DEFAULT_SETTINGS) };
export class StorageManager {
  static getVoices() { return copy(memory.voices); }
  static saveVoices(voices) { memory.voices = copy(voices); }
  static getFolders() { return copy(memory.folders); }
  static saveFolders(folders) { memory.folders = copy(folders); }
  static getSettings() { return copy(memory.settings); }
  static saveSettings(settings) { memory.settings = copy(settings); }
  static clear() { memory = { folders: null, voices: null, settings: copy(DEFAULT_SETTINGS) }; }
}
