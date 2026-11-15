import { StorageManager } from './storage.js';
import { CloudClient, safeAssetUrl, cloneSnapshot, prepareCover, isExtensionContext } from './cloud-client.js';

const DEFAULT_FOLDERS = [
  { id: "all", name: "Todas" },
  { id: "f_favorites", name: "Favoritas" },
  { id: "f_sueltas", name: "Voces Sueltas" }
];

const DEFAULT_VOICES = [];

class App {
  constructor() {
    this.voices = [];
    this.folders = [];
    this.settings = StorageManager.getSettings();
    this.selectedVoiceIds = new Set();
    this.isMultiSelectActive = false;
    this.activeFolderId = 'all';
    this.audioPlayers = new Map();
    this.playbackSources = new Map();
    this.currentPlayingId = null;
    this.editingVoiceId = null;
    this.currentCroppedImage = '';
    this.cloud = new CloudClient();
    this.cloud.onQuota = () => this.renderApiQuota();
    this.metadataRequests = new Map();
    this.audioRetryIds = new Set();
    this.isRefreshing = false;
    this.isSavingVoice = false;
    this.coverChanged = false;
    this.modalSession = 0;
    this.imageReadSerial = 0;
    this.coverRefreshIds = new Set();
    this.displayedIdentity = null;

    this.init();
  }

  async init() {
    this.bindDOM();
    this.bindEvents();
    this.bindCloudEvents();
    this.applySettings();
    this.renderFolders();
    this.render();
    await this.loadCloudConfiguration();
    await this.checkServerStatus(true);
    this.apiClockTimer = setInterval(() => this.renderApiQuota(), 1000);
    this.cloudStatusTimer = setInterval(() => {
      if (document.visibilityState === 'visible') this.cloud.status().catch(() => {});
    }, 5000);
    window.addEventListener('beforeunload', event => {
      if (this.cloud.pending || this.cloud.unsaved) { event.preventDefault(); event.returnValue = ''; }
    });
  }

  renderApiQuota() {
    const widget = document.getElementById('apiQuota');
    if (!widget) return;
    const quota = this.cloud.rateLimit;
    if (!quota) { widget.textContent = 'API —/120 · --:--'; return; }
    const seconds = Math.max(0, Math.ceil((Number(quota.resetAt) - Date.now()) / 1000));
    const clock = Number.isFinite(seconds) ? String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0') : '--:--';
    const used = Number.isFinite(quota.used) ? quota.used : Math.max(0, quota.limit - quota.remaining);
    widget.textContent = 'API ' + used + '/' + quota.limit + ' · quedan ' + quota.remaining + ' · ' + clock + (quota.source === 'estimate' ? ' · estimado' : '');
    widget.classList.toggle('quota-exhausted', quota.remaining <= 0);
    widget.title = 'Consultas de Supabase Management API. Cuota compartida por el usuario/proyecto/endpoint entre todos sus tokens. ' + (quota.source === 'estimate' ? 'Estimación de esta extensión; no incluye otros clientes.' : 'Datos de la última respuesta del servidor.') + ' ' + (seconds === 0 ? 'La ventana venció; la próxima respuesta confirmará la cuota nueva.' : 'Reinicio en ' + clock + '.') + ' Llamadas en esta sesión: ' + (quota.requestsThisSession ?? '—') + '. El reloj y cloud_status no consumen consultas. Fish Audio se cuenta aparte.';
  }

  bindCloudEvents() {
    this.cloudLogin = document.getElementById('cloudLogin');
    this.cloudLoginForm = document.getElementById('cloudLoginForm');
    this.cloudTokenInput = document.getElementById('cloudTokenInput');
    this.cloudProjectInput = document.getElementById('cloudProjectInput');
    this.cloudLibraryInput = document.getElementById('cloudLibraryInput');
    this.cloudLoginError = document.getElementById('cloudLoginError');
    this.cloudCachePanel = document.getElementById('cloudCachePanel');
    this.cloudCacheMessage = document.getElementById('cloudCacheMessage');
    document.getElementById('cloudFetchInitialBtn')?.addEventListener('click', () => this.refreshCloudManually());
    document.getElementById('cloudCacheLogoutBtn')?.addEventListener('click', () => this.disconnectCloud());
    const tokenHint = document.getElementById('cloudTokenHint');
    if (tokenHint) tokenHint.textContent = 'La sesión se recuerda en este navegador hasta que pulses Cerrar sesión.';
    this.cloudLoginForm?.addEventListener('submit', async event => {
      event.preventDefault();
      const token = this.cloudTokenInput.value.trim();
      this.cloudTokenInput.value = '';
      const submit = document.getElementById('cloudConnectBtn');
      const originalLabel = submit.textContent;
      submit.disabled = true; submit.textContent = 'Preparando biblioteca…'; this.cloudLoginError.textContent = '';
      try {
        const result = await this.cloud.connect(token, this.cloudProjectInput.value.trim(), this.cloudLibraryInput.value.trim());
        this.applyCloudSnapshot(result);
        this.showCloudLogin(false);
        this.setCloudStatus('online', 'Supabase conectado');
        this.setCloudNotice(''); this.reportCacheWarning(result);
      } catch (error) {
        this.cloudLoginError.textContent = !isExtensionContext() && error.code === 'NETWORK'
          ? error.message + ' Comprueba tu conexión y el acceso del proyecto desde la web. Vuelve a introducir el token para reintentar.'
          : error.message;
        this.setCloudStatus('offline', 'Sin conexión');
      }
      finally { submit.disabled = false; submit.textContent = originalLabel; }
    });
    document.getElementById('cloudCancelLoginBtn')?.addEventListener('click', () => this.showCloudLogin(false));
    document.getElementById('cloudLogoutBtn')?.addEventListener('click', () => this.disconnectCloud());
    document.getElementById('cloudReconnectBtn')?.addEventListener('click', () => this.showCloudLogin(true));
    document.getElementById('cloudRefreshBtn')?.addEventListener('click', () => this.refreshCloudManually());
    document.getElementById('cloudReloadBtn')?.addEventListener('click', () => this.refreshCloudManually());
    document.getElementById('cloudRetryBtn')?.addEventListener('click', async () => {
      this.setCloudStatus('pending', 'Guardando cambios…');
      try { const result = await this.cloud.retry(); this.setCloudNotice(''); this.setCloudStatus('online', 'Guardado en Supabase'); this.reportCacheWarning(result); }
      catch (error) { this.reportCloudError(error); }
    });
  }

  async loadCloudConfiguration() {
    try {
      const response = await fetch('config.json');
      if (!response.ok) return;
      const config = await response.json();
      this.cloudProjectInput.value = config.projectRef || '';
      this.cloudLibraryInput.value = config.libraryId || '';
      if (!this.cloud.connected) { this.cloud.projectRef = config.projectRef || null; this.cloud.libraryId = config.libraryId || null; }
    } catch { /* The advanced fields remain available if config is missing. */ }
  }

  showCloudLogin(show, cacheMissing = false) {
    this.cloudLogin.hidden = !show;
    this.cloudLoginForm.hidden = cacheMissing;
    if (this.cloudCachePanel) this.cloudCachePanel.hidden = !cacheMissing;
    const loginTitle = document.getElementById('cloudLoginTitle');
    if (loginTitle) loginTitle.textContent = cacheMissing ? 'Actualiza tu biblioteca' : 'Conecta tu biblioteca online';
    document.getElementById('cloudCancelLoginBtn').hidden = !this.cloud.connected;
    const container = document.querySelector('.app-container');
    container.inert = show;
    container.setAttribute('aria-hidden', String(show));
    if (show) {
      this.cloudTokenInput.value = '';
      if (cacheMissing) document.getElementById('cloudFetchInitialBtn')?.focus(); else this.cloudTokenInput.focus();
    }
  }

  setCloudStatus(kind, text) {
    const pill = document.getElementById('syncStatusPill');
    pill?.classList.remove('online', 'offline', 'pending');
    pill?.classList.add(kind);
    if (pill) pill.title = text;
    const label = document.getElementById('syncStatusText');
    if (label) label.textContent = text;
  }

  setCloudNotice(message, conflict = false, manualRefreshOnly = false) {
    const notice = document.getElementById('cloudNotice');
    notice.hidden = !message;
    document.getElementById('cloudNoticeText').textContent = message;
    document.getElementById('cloudRetryBtn').hidden = conflict || manualRefreshOnly;
    document.getElementById('cloudReloadBtn').hidden = !conflict && !manualRefreshOnly;
    document.getElementById('cloudReloadBtn').textContent = manualRefreshOnly ? 'Actualizar' : 'Recargar versión online';
    document.getElementById('cloudReconnectBtn').hidden = manualRefreshOnly;
  }

  reportCacheWarning(result) {
    if (result?.cacheWarning) this.setCloudNotice('Los datos están online, pero no se pudo actualizar la copia local. Actualiza manualmente al reabrir para consultar la versión más reciente.', false, true);
  }

  reportCloudError(error) {
    this.setCloudStatus('offline', this.cloud.unsaved ? 'Cambios sin guardar' : 'Sin conexión');
    if (error.code === 'RATE_LIMIT') {
      this.setCloudNotice('Se agotó la cuota de Supabase. Tus cambios siguen en esta ventana. Espera a que termine el contador y pulsa Reintentar guardado; cambiar de token no reinicia la cuota.');
      return;
    }
    if (error.code === 'CONFIG_CHANGED') {
      this.setCloudNotice('Otra ventana conectó un proyecto o biblioteca diferente. Esta ventana conserva sus cambios y no los enviará a la otra biblioteca. Exporta una copia y vuelve a conectar la biblioteca correcta.');
      return;
    }
    const message = error.code === 'CONFLICT'
      ? 'La biblioteca cambió en otro dispositivo. Tus cambios siguen en esta ventana. Exporta una copia antes de recargar; no se sobrescribió la versión online.'
      : 'No se pudo guardar o consultar Supabase. Tus cambios siguen en esta ventana. Reintenta o exporta una copia antes de cerrar.';
    this.setCloudNotice(message, error.code === 'CONFLICT');
  }

  unlinkDiskBackup() {
    this.fileHandle = null;
    if (this.linkDiskFileBtn) { this.linkDiskFileBtn.style.background = ''; this.linkDiskFileBtn.style.borderColor = ''; this.linkDiskFileBtn.title = 'Vincular una copia opcional en tu PC'; }
  }

  applyCloudSnapshot(result) {
    const snapshot = result.snapshot;
    if (result.projectRef && result.libraryId) {
      const identity = result.projectRef + '/' + result.libraryId;
      if (this.displayedIdentity && this.displayedIdentity !== identity) { this.unlinkDiskBackup(); this.playbackSources?.clear(); }
      this.displayedIdentity = identity;
    }
    this.stopAllAudio();
    this.folders = this.ensureFixedFoldersOrder(cloneSnapshot(snapshot.folders));
    const folderIds = new Set(this.folders.map(folder => folder.id));
    this.voices = snapshot.voices.map(voice => ({
      ...voice,
      id: String(voice.id),
      title: String(voice.title || 'Voz Fish Audio'),
      url: safeAssetUrl(voice.url),
      audioUrl: safeAssetUrl(voice.audioUrl, 'audio'),
      coverImage: safeAssetUrl(voice.coverImage, 'image'),
      folderId: folderIds.has(voice.folderId) ? voice.folderId : 'f_sueltas'
    }));
    this.prunePlaybackSources();
    this.settings = { showQuickFolderBadge: false, showSidebarFolders: true, showNotes: true, ...(snapshot.settings || {}) };
    this.selectedVoiceIds.clear();
    if (!folderIds.has(this.activeFolderId)) this.activeFolderId = 'all';
    StorageManager.saveFolders(this.folders); StorageManager.saveVoices(this.voices); StorageManager.saveSettings(this.settings);
    this.applySettings(); this.renderFolders(); this.render();
  }

  stopAllAudio() {
    this.desiredPlayingId = null; this.playRequestId = (this.playRequestId || 0) + 1;
    this.stopSmoothProgressLoop();
    this.audioPlayers.forEach(audio => { audio.pause(); audio.removeAttribute('src'); audio.load(); });
    this.audioPlayers.clear(); this.currentPlayingId = null;
  }

  async refreshCloudManually() {
    if (this.isRefreshing) return;
    if (this.cloud.pending) { this.setCloudNotice('Espera a que termine el guardado actual.'); return; }
    if (this.cloud.unsaved && !window.confirm('Hay cambios sin guardar en esta ventana. Exporta una copia si necesitas conservarlos. ¿Descartar esos cambios y cargar la versión online?')) return;
    this.isRefreshing = true;
    const buttons = ['cloudRefreshBtn', 'cloudReloadBtn', 'cloudFetchInitialBtn'].map(id => document.getElementById(id)).filter(Boolean);
    buttons.forEach(button => { button.disabled = true; });
    try {
      this.setCloudStatus('pending', 'Consultando Supabase…');
      if (this.cloudCacheMessage) this.cloudCacheMessage.textContent = 'Consultando la biblioteca en Supabase…';
      const result = await this.cloud.load({ discardPending: true });
      this.applyCloudSnapshot(result); this.showCloudLogin(false); this.setCloudStatus('online', 'Supabase actualizado'); this.setCloudNotice('');
      this.coverRefreshIds.clear(); this.reportCacheWarning(result);
    } catch (error) {
      this.reportCloudError(error);
      if (this.cloudLogin && !this.cloudLogin.hidden && this.cloudCacheMessage) this.cloudCacheMessage.textContent = error.message + ' Pulsa Actualizar para volver a intentarlo.';
    } finally {
      this.isRefreshing = false;
      buttons.forEach(button => { button.disabled = false; });
    }
  }

  async disconnectCloud() {
    if ((this.cloud.pending || this.cloud.unsaved) && !window.confirm('Hay cambios pendientes. Expórtalos antes de salir si necesitas conservarlos. ¿Cerrar la sesión y borrar la copia de esta ventana?')) return;
    try { await this.cloud.disconnect(); }
    catch { this.setCloudNotice('No se pudo cerrar la sesión. Vuelve a intentarlo.'); return; }
    this.hideModal(); this.hideFolderModal(); this.hideEditFolderModal(); this.hideConfirmDialog(); this.hideSettingsModal();
    this.stopAllAudio(); this.playbackSources?.clear(); this.unlinkDiskBackup(); this.displayedIdentity = null; StorageManager.clear();
    this.voices = []; this.folders = this.ensureFixedFoldersOrder([]); this.settings = StorageManager.getSettings();
    this.selectedVoiceIds.clear(); this.renderFolders(); this.render(); this.setCloudNotice(''); this.setCloudStatus('offline', 'Sesión cerrada'); this.showCloudLogin(true);
  }

  syncModalScrollLock() {
    if (typeof document === 'undefined' || !document.documentElement?.classList || !document.body?.classList) return;
    const open = [this.addModal, this.createFolderModal, this.editFolderModal, this.confirmModal, this.settingsModal]
      .some(modal => modal && !modal.hidden && modal.style?.display && modal.style.display !== 'none');
    const root = document.documentElement;
    const body = document.body;
    if (open && !this.modalScrollLock) {
      this.modalScrollLock = {
        x: globalThis.window?.scrollX || 0,
        y: globalThis.window?.scrollY || 0,
        rootHadClass: root.classList.contains('vault-modal-open'),
        bodyHadClass: body.classList.contains('vault-modal-open')
      };
      root.classList.add('vault-modal-open'); body.classList.add('vault-modal-open');
    } else if (!open && this.modalScrollLock) {
      const previous = this.modalScrollLock;
      this.modalScrollLock = null;
      if (!previous.rootHadClass) root.classList.remove('vault-modal-open');
      if (!previous.bodyHadClass) body.classList.remove('vault-modal-open');
      if (globalThis.window?.scrollTo && (window.scrollX !== previous.x || window.scrollY !== previous.y)) window.scrollTo({ left: previous.x, top: previous.y, behavior: 'instant' });
    }
  }

  bindDOM() {
    this.openTabBtn = document.getElementById('openTabBtn');

    this.openModalBtn = document.getElementById('openModalBtn');
    this.addModal = document.getElementById('addModal');
    this.closeModalBtn = document.getElementById('closeModalBtn');
    this.cancelModalBtn = document.getElementById('cancelModalBtn');
    this.modalAddForm = document.getElementById('modalAddForm');
    this.modalTitle = document.getElementById('modalTitle');

    this.modalTitleInput = document.getElementById('modalTitleInput');
    this.modalUrlInput = document.getElementById('modalUrlInput');
    this.modalNotesInput = document.getElementById('modalNotesInput');
    this.modalSaveError = document.getElementById('modalSaveError');
    this.saveVoiceBtn = document.getElementById('saveVoiceBtn');
    this.modalFolderSelect = document.getElementById('modalFolderSelect');

    // Folder elements & controls
    this.folderTabsWrapper = document.getElementById('folderTabsWrapper');
    this.scrollFoldersLeft = document.getElementById('scrollFoldersLeft');
    this.scrollFoldersRight = document.getElementById('scrollFoldersRight');
    this.openFolderModalBtn = document.getElementById('openFolderModalBtn');

    // Left Sidebar Folder Elements
    this.sidebarFolderList = document.getElementById('sidebarFolderList');
    this.sidebarOpenFolderModalBtn = document.getElementById('sidebarOpenFolderModalBtn');

    // Active Folder Header Actions
    this.folderHeaderActions = document.getElementById('folderHeaderActions');
    this.activeFolderNameEl = document.getElementById('activeFolderNameEl');
    this.editFolderBtn = document.getElementById('editFolderBtn');
    this.deleteFolderBtn = document.getElementById('deleteFolderBtn');

    // Create Folder Modal
    this.createFolderModal = document.getElementById('createFolderModal');
    this.closeFolderModalBtn = document.getElementById('closeFolderModalBtn');
    this.cancelFolderModalBtn = document.getElementById('cancelFolderModalBtn');
    this.createFolderForm = document.getElementById('createFolderForm');
    this.newFolderNameInput = document.getElementById('newFolderNameInput');

    // Edit Folder Modal
    this.editFolderModal = document.getElementById('editFolderModal');
    this.closeEditFolderModalBtn = document.getElementById('closeEditFolderModalBtn');
    this.cancelEditFolderModalBtn = document.getElementById('cancelEditFolderModalBtn');
    this.editFolderForm = document.getElementById('editFolderForm');
    this.editFolderNameInput = document.getElementById('editFolderNameInput');

    // Multi-Select Elements
    this.toggleMultiSelectBtn = document.getElementById('toggleMultiSelectBtn');
    this.toggleMultiSelectMode = document.getElementById('toggleMultiSelectMode');
    this.batchActionBar = document.getElementById('batchActionBar');
    this.batchCountText = document.getElementById('batchCountText');
    this.selectAllBatchBtn = document.getElementById('selectAllBatchBtn');
    this.batchFolderSelect = document.getElementById('batchFolderSelect');
    this.applyBatchMoveBtn = document.getElementById('applyBatchMoveBtn');
    this.closeBatchBarBtn = document.getElementById('closeBatchBarBtn');

    // Settings Modal Elements
    this.settingsBtn = document.getElementById('settingsBtn');
    this.settingsModal = document.getElementById('settingsModal');
    this.closeSettingsModalBtn = document.getElementById('closeSettingsModalBtn');
    this.saveSettingsBtn = document.getElementById('saveSettingsBtn');
    this.toggleQuickFolderBadge = document.getElementById('toggleQuickFolderBadge');
    this.toggleSidebarFolders = document.getElementById('toggleSidebarFolders');
    this.toggleShowNotes = document.getElementById('toggleShowNotes');

    // Confirm Action Modal
    this.confirmModal = document.getElementById('confirmModal');
    this.confirmModalTitle = document.getElementById('confirmModalTitle');
    this.confirmModalText = document.getElementById('confirmModalText');
    this.closeConfirmModalBtn = document.getElementById('closeConfirmModalBtn');
    this.cancelConfirmBtn = document.getElementById('cancelConfirmBtn');
    this.acceptConfirmBtn = document.getElementById('acceptConfirmBtn');
    this.onConfirmCallback = null;

    // Import / Export PC Storage & Direct File Auto-Sync
    this.linkDiskFileBtn = document.getElementById('linkDiskFileBtn');
    this.exportDataBtn = document.getElementById('exportDataBtn');
    this.importDataBtn = document.getElementById('importDataBtn');
    this.importFileInput = document.getElementById('importFileInput');
    this.fileHandle = null;

    // Image Upload & Crop elements
    this.modalFileInput = document.getElementById('modalFileInput');
    this.cropCanvas = document.getElementById('cropCanvas');
    this.imagePlaceholder = document.getElementById('imagePlaceholder');
    this.removeImgBtn = document.getElementById('removeImgBtn');
    this.imageDropZone = document.getElementById('imageDropZone');

    this.voicesList = document.getElementById('voicesList');
    this.emptyState = document.getElementById('emptyState');
    this.searchInput = document.getElementById('searchInput');
    this.totalCountEl = document.getElementById('totalCount');

    // Sort Order Button
    this.sortOrderBtn = document.getElementById('sortOrderBtn');
    this.sortIconDesc = document.getElementById('sortIconDesc');
    this.sortIconAsc = document.getElementById('sortIconAsc');
    this.sortOrder = 'desc';

    this.checkViewMode();
  }

  checkViewMode() {
    if (!isExtensionContext()) { if (this.openTabBtn) { this.openTabBtn.hidden = true; this.openTabBtn.style.display = 'none'; } return; }
    const isExtensionPopup = window.chrome && chrome.extension && chrome.extension.getViews &&
                             chrome.extension.getViews({ type: 'popup' }).includes(window);

    if (!isExtensionPopup && window.innerWidth >= 600) {
      if (this.openTabBtn) this.openTabBtn.style.display = 'none';
    }
  }


  ensureFixedFoldersOrder(folders) {
    if (!Array.isArray(folders)) return JSON.parse(JSON.stringify(DEFAULT_FOLDERS));

    const allFolder = folders.find(f => f.id === 'all') || { id: 'all', name: 'Todas' };
    const favoritesFolder = folders.find(f => f.id === 'f_favorites') || { id: 'f_favorites', name: 'Favoritas' };
    const sueltasFolder = folders.find(f => f.id === 'f_sueltas') || { id: 'f_sueltas', name: 'Voces Sueltas' };

    allFolder.name = 'Todas';
    favoritesFolder.name = 'Favoritas';
    sueltasFolder.name = 'Voces Sueltas';

    const customFolders = folders.filter(f => f.id !== 'all' && f.id !== 'f_favorites' && f.id !== 'f_sueltas');

    return [allFolder, favoritesFolder, sueltasFolder, ...customFolders];
  }


  async checkServerStatus(resume = false) {
    try {
      const status = resume && !this.cloud.connected && !this.cloud.pending && !this.cloud.unsaved
        ? await this.cloud.restore() : await this.cloud.status();
      if (status.connected && resume) {
        if (this.cloudProjectInput) this.cloudProjectInput.value = status.projectRef || this.cloud.projectRef || '';
        if (this.cloudLibraryInput) this.cloudLibraryInput.value = status.libraryId || this.cloud.libraryId || '';
        if (status.cacheAvailable && status.snapshot) {
          this.applyCloudSnapshot(status); this.showCloudLogin(false); this.setCloudStatus('online', 'Copia guardada · sin consultas'); this.setCloudNotice('');
          if (status.snapshot.voices.some(voice => voice.coverStoragePath && !voice.coverImage)) this.setCloudNotice('Algunas portadas necesitan renovar su enlace. Pulsa Actualizar cuando quieras consultarlas en Supabase.', false, true);
        } else {
          this.setCloudStatus('offline', 'Copia local pendiente');
          if (this.cloudCacheMessage) this.cloudCacheMessage.textContent = 'Tu sesión está guardada, pero este navegador aún no tiene una copia de la biblioteca. Pulsa Actualizar para consultarla. Abrir o cambiar de pestaña no consulta Supabase.';
          this.showCloudLogin(true, true);
        }
      } else if (!status.connected) { this.setCloudStatus('offline', 'Conecta tu biblioteca'); this.showCloudLogin(true); }
    } catch (error) {
      this.setCloudStatus('offline', 'Conecta tu biblioteca'); this.showCloudLogin(true);
      if (this.cloudLoginError) this.cloudLoginError.textContent = error.message || 'No se pudo recuperar la sesión guardada. Vuelve a conectar.';
    }
  }

  bindEvents() {
    if (this.openTabBtn) {
      this.openTabBtn.addEventListener('click', () => this.openNewTab());
    }

    if (this.openModalBtn) {
      this.openModalBtn.addEventListener('click', () => this.showModal());
    }
    if (this.closeModalBtn) {
      this.closeModalBtn.addEventListener('click', () => this.hideModal());
    }
    if (this.cancelModalBtn) {
      this.cancelModalBtn.addEventListener('click', () => this.hideModal());
    }

    if (this.addModal) {
      this.addModal.addEventListener('click', (e) => {
        if (e.target === this.addModal) this.hideModal();
      });
    }

    // Folder Scroll Controls (Arrows, Wheel & Drag)
    if (this.scrollFoldersLeft) {
      this.scrollFoldersLeft.addEventListener('click', () => {
        if (this.folderTabsWrapper) this.folderTabsWrapper.scrollBy({ left: -180, behavior: 'smooth' });
      });
    }
    if (this.scrollFoldersRight) {
      this.scrollFoldersRight.addEventListener('click', () => {
        if (this.folderTabsWrapper) this.folderTabsWrapper.scrollBy({ left: 180, behavior: 'smooth' });
      });
    }

    if (this.folderTabsWrapper) {
      this.folderTabsWrapper.addEventListener('wheel', (e) => {
        if (e.deltaY !== 0) {
          e.preventDefault();
          this.folderTabsWrapper.scrollLeft += e.deltaY;
        }
      }, { passive: false });

      let isDown = false;
      let startX, scrollLeft;

      this.folderTabsWrapper.addEventListener('mousedown', (e) => {
        isDown = true;
        startX = e.pageX - this.folderTabsWrapper.offsetLeft;
        scrollLeft = this.folderTabsWrapper.scrollLeft;
      });

      this.folderTabsWrapper.addEventListener('mouseleave', () => { isDown = false; });
      this.folderTabsWrapper.addEventListener('mouseup', () => { isDown = false; });

      this.folderTabsWrapper.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        e.preventDefault();
        const x = e.pageX - this.folderTabsWrapper.offsetLeft;
        const walk = (x - startX) * 1.5;
        this.folderTabsWrapper.scrollLeft = scrollLeft - walk;
      });
    }

    // Create Folder Modal Events
    if (this.openFolderModalBtn) {
      this.openFolderModalBtn.addEventListener('click', () => this.showFolderModal());
    }
    if (this.sidebarOpenFolderModalBtn) {
      this.sidebarOpenFolderModalBtn.addEventListener('click', () => this.showFolderModal());
    }
    if (this.closeFolderModalBtn) {
      this.closeFolderModalBtn.addEventListener('click', () => this.hideFolderModal());
    }
    if (this.cancelFolderModalBtn) {
      this.cancelFolderModalBtn.addEventListener('click', () => this.hideFolderModal());
    }

    if (this.createFolderModal) {
      this.createFolderModal.addEventListener('click', (e) => {
        if (e.target === this.createFolderModal) this.hideFolderModal();
      });
    }

    if (this.createFolderForm) {
      this.createFolderForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveNewFolder();
      });
    }

    // Active Folder Actions (Rename & Delete)
    if (this.editFolderBtn) {
      this.editFolderBtn.addEventListener('click', () => this.showEditFolderModal());
    }
    if (this.deleteFolderBtn) {
      this.deleteFolderBtn.addEventListener('click', () => this.deleteActiveFolder());
    }

    if (this.closeEditFolderModalBtn) {
      this.closeEditFolderModalBtn.addEventListener('click', () => this.hideEditFolderModal());
    }
    if (this.cancelEditFolderModalBtn) {
      this.cancelEditFolderModalBtn.addEventListener('click', () => this.hideEditFolderModal());
    }

    if (this.editFolderModal) {
      this.editFolderModal.addEventListener('click', (e) => {
        if (e.target === this.editFolderModal) this.hideEditFolderModal();
      });
    }

    if (this.editFolderForm) {
      this.editFolderForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveFolderEdits();
      });
    }

    // Confirm Modal Events
    if (this.closeConfirmModalBtn) {
      this.closeConfirmModalBtn.addEventListener('click', () => this.hideConfirmDialog());
    }
    if (this.cancelConfirmBtn) {
      this.cancelConfirmBtn.addEventListener('click', () => this.hideConfirmDialog());
    }
    if (this.confirmModal) {
      this.confirmModal.addEventListener('click', (e) => {
        if (e.target === this.confirmModal) this.hideConfirmDialog();
      });
    }
    if (this.acceptConfirmBtn) {
      this.acceptConfirmBtn.addEventListener('click', () => {
        const callback = this.onConfirmCallback;
        this.hideConfirmDialog();
        if (typeof callback === 'function') {
          callback();
        }
      });
    }

    // Settings Modal Events
    if (this.settingsBtn) {
      this.settingsBtn.addEventListener('click', () => this.showSettingsModal());
    }
    if (this.closeSettingsModalBtn) {
      this.closeSettingsModalBtn.addEventListener('click', () => this.hideSettingsModal());
    }
    if (this.saveSettingsBtn) {
      this.saveSettingsBtn.addEventListener('click', () => this.saveSettingsFromModal());
    }
    if (this.settingsModal) {
      this.settingsModal.addEventListener('click', (e) => {
        if (e.target === this.settingsModal) this.hideSettingsModal();
      });
    }

    if (this.toggleQuickFolderBadge) {
      this.toggleQuickFolderBadge.addEventListener('change', (e) => {
        this.settings.showQuickFolderBadge = e.target.checked;
        StorageManager.saveSettings(this.settings);
        this.autoSyncDiskFile();
        this.render();
      });
    }

    if (this.toggleSidebarFolders) {
      this.toggleSidebarFolders.addEventListener('change', (e) => {
        this.settings.showSidebarFolders = e.target.checked;
        StorageManager.saveSettings(this.settings);
        this.autoSyncDiskFile();
        this.applySettings();
      });
    }

    if (this.toggleShowNotes) {
      this.toggleShowNotes.addEventListener('change', event => this.setShowNotes(event.target.checked));
    }

    // Multi-Select & Batch Move Events
    if (this.toggleMultiSelectBtn) {
      this.toggleMultiSelectBtn.addEventListener('click', () => {
        this.setMultiSelectMode(!this.isMultiSelectActive);
      });
    }

    if (this.toggleMultiSelectMode) {
      this.toggleMultiSelectMode.addEventListener('change', (e) => {
        this.setMultiSelectMode(e.target.checked);
      });
    }

    if (this.selectAllBatchBtn) {
      this.selectAllBatchBtn.addEventListener('click', () => this.toggleSelectAllBatch());
    }

    if (this.applyBatchMoveBtn) {
      this.applyBatchMoveBtn.addEventListener('click', () => this.applyBatchMove());
    }

    if (this.closeBatchBarBtn) {
      this.closeBatchBarBtn.addEventListener('click', () => this.setMultiSelectMode(false));
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.addModal && this.addModal.style.display !== 'none') this.hideModal();
        if (this.createFolderModal && this.createFolderModal.style.display !== 'none') this.hideFolderModal();
        if (this.editFolderModal && this.editFolderModal.style.display !== 'none') this.hideEditFolderModal();
        if (this.confirmModal && this.confirmModal.style.display !== 'none') this.hideConfirmDialog();
        if (this.settingsModal && this.settingsModal.style.display !== 'none') this.hideSettingsModal();
      }
    });

    // Direct PC File Sync Link Button
    if (this.linkDiskFileBtn) {
      this.linkDiskFileBtn.addEventListener('click', () => this.linkDiskFile());
    }

    // PC File Storage Export & Import
    if (this.exportDataBtn) {
      this.exportDataBtn.addEventListener('click', () => this.exportData());
    }
    if (this.importDataBtn && this.importFileInput) {
      this.importDataBtn.addEventListener('click', () => this.importFileInput.click());
      this.importFileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          this.importData(e.target.files[0]);
        }
      });
    }

    // Image Upload Events
    if (this.modalFileInput) {
      this.modalFileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
          this.processImageFile(e.target.files[0]);
        }
      });
    }

    if (this.removeImgBtn) {
      this.removeImgBtn.addEventListener('click', () => this.clearCroppedImage());
    }

    // Clipboard Paste Support (Ctrl + V)
    document.addEventListener('paste', (e) => {
      if (this.addModal && this.addModal.style.display !== 'none') {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (let item of items) {
          if (item.type.indexOf('image') !== -1) {
            const blob = item.getAsFile();
            this.processImageFile(blob);
            break;
          }
        }
      }
    });

    // Modal Form submission
    if (this.modalAddForm) {
      this.modalAddForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveVoiceFromModal();
      });
    }

    if (this.searchInput) {
      this.searchInput.addEventListener('input', () => this.render());
    }

    if (this.sortOrderBtn) {
      this.sortOrderBtn.addEventListener('click', () => {
        this.sortOrder = this.sortOrder === 'desc' ? 'asc' : 'desc';
        if (this.sortIconDesc && this.sortIconAsc) {
          this.sortIconDesc.style.display = this.sortOrder === 'desc' ? 'block' : 'none';
          this.sortIconAsc.style.display = this.sortOrder === 'asc' ? 'block' : 'none';
        }
        if (this.sortOrderBtn) {
          this.sortOrderBtn.title = this.sortOrder === 'desc'
            ? 'Orden: Más reciente a más antiguo'
            : 'Orden: Más antiguo a más reciente';
        }
        this.render();
      });
    }
  }

  renderFolders() {
    this.folders = this.ensureFixedFoldersOrder(this.folders);

    if (this.folderTabsWrapper) this.folderTabsWrapper.innerHTML = '';
    if (this.sidebarFolderList) this.sidebarFolderList.innerHTML = '';

    const systemFolderIds = new Set(['all', 'f_favorites', 'f_sueltas']);

    this.folders.forEach(folder => {
      let count = 0;
      if (folder.id === 'all') {
        count = this.voices.length;
      } else if (folder.id === 'f_favorites') {
        count = this.voices.filter(v => !!v.isFavorite).length;
      } else {
        count = this.voices.filter(v => v.folderId === folder.id).length;
      }

      const isSystemFolder = systemFolderIds.has(folder.id);

      // 1. Render Top Carousel Tab
      if (this.folderTabsWrapper) {
        const tab = document.createElement('button');
        tab.className = `folder-tab ${this.activeFolderId === folder.id ? 'active' : ''}`;
        tab.innerHTML = `
          <span>${this.escape(folder.name)}</span>
          <span class="folder-tab-count">(${count})</span>
        `;

        tab.addEventListener('click', () => {
          if (this.isReordering) return;
          this.activeFolderId = folder.id;
          this.renderFolders();
          this.render();
        });

        if (!isSystemFolder) {
          tab.draggable = true;

          tab.addEventListener('dragstart', (e) => {
            this.draggedFolderId = folder.id;
            this.isReordering = true;
            tab.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
          });

          tab.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            tab.classList.add('drag-over');
          });

          tab.addEventListener('dragleave', () => {
            tab.classList.remove('drag-over');
          });

          tab.addEventListener('drop', (e) => {
            e.preventDefault();
            tab.classList.remove('drag-over');
            if (this.draggedFolderId && this.draggedFolderId !== folder.id && !isSystemFolder) {
              const fromIndex = this.folders.findIndex(f => f.id === this.draggedFolderId);
              const toIndex = this.folders.findIndex(f => f.id === folder.id);

              if (fromIndex !== -1 && toIndex !== -1) {
                const [moved] = this.folders.splice(fromIndex, 1);
                this.folders.splice(toIndex, 0, moved);
                this.folders = this.ensureFixedFoldersOrder(this.folders);
                StorageManager.saveFolders(this.folders);
                this.autoSyncDiskFile();
                this.renderFolders();
              }
            }
          });

          tab.addEventListener('dragend', () => {
            tab.classList.remove('dragging');
            this.draggedFolderId = null;
            setTimeout(() => { this.isReordering = false; }, 100);
          });
        }

        this.folderTabsWrapper.appendChild(tab);
      }

      // 2. Render Left Sidebar Folder Item
      if (this.sidebarFolderList) {
        const item = document.createElement('button');
        item.className = `sidebar-folder-item ${this.activeFolderId === folder.id ? 'active' : ''}`;

        item.innerHTML = `
          <div class="sidebar-folder-left">
            <span class="sidebar-folder-name">${this.escape(folder.name)}</span>
          </div>
          <span class="sidebar-folder-count">${count}</span>
        `;

        item.addEventListener('click', () => {
          if (this.isReordering) return;
          this.activeFolderId = folder.id;
          this.renderFolders();
          this.render();
        });

        if (!isSystemFolder) {
          item.draggable = true;

          item.addEventListener('dragstart', (e) => {
            this.draggedFolderId = folder.id;
            this.isReordering = true;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
          });

          item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            item.classList.add('drag-over');
          });

          item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over');
          });

          item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('drag-over');
            if (this.draggedFolderId && this.draggedFolderId !== folder.id && !isSystemFolder) {
              const fromIndex = this.folders.findIndex(f => f.id === this.draggedFolderId);
              const toIndex = this.folders.findIndex(f => f.id === folder.id);

              if (fromIndex !== -1 && toIndex !== -1) {
                const [moved] = this.folders.splice(fromIndex, 1);
                this.folders.splice(toIndex, 0, moved);
                this.folders = this.ensureFixedFoldersOrder(this.folders);
                StorageManager.saveFolders(this.folders);
                this.autoSyncDiskFile();
                this.renderFolders();
              }
            }
          });

          item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            this.draggedFolderId = null;
            setTimeout(() => { this.isReordering = false; }, 100);
          });
        }

        this.sidebarFolderList.appendChild(item);
      }
    });

    // Populate Folder Select in Modal (Excluding system folders 'all', 'f_favorites' and 'f_sueltas')
    if (this.modalFolderSelect) {
      this.modalFolderSelect.innerHTML = '';

      const defaultOpt = document.createElement('option');
      defaultOpt.value = 'f_sueltas';
      defaultOpt.textContent = 'Sin carpeta';
      this.modalFolderSelect.appendChild(defaultOpt);

      this.folders.forEach(folder => {
        if (folder.id === 'all' || folder.id === 'f_favorites' || folder.id === 'f_sueltas') return;
        const opt = document.createElement('option');
        opt.value = folder.id;
        opt.textContent = folder.name;
        this.modalFolderSelect.appendChild(opt);
      });
    }

    // Handle Active Folder Header Actions Bar (Protected for 'all', 'f_favorites' and 'f_sueltas')
    if (this.folderHeaderActions && this.activeFolderNameEl) {
      const currentFolder = this.folders.find(f => f.id === this.activeFolderId);
      if (currentFolder && currentFolder.id !== 'all' && currentFolder.id !== 'f_favorites' && currentFolder.id !== 'f_sueltas') {
        this.activeFolderNameEl.textContent = currentFolder.name;
        this.folderHeaderActions.style.display = 'flex';
      } else {
        this.folderHeaderActions.style.display = 'none';
      }
    }
  }

  showFolderModal() {
    if (this.newFolderNameInput) this.newFolderNameInput.value = '';
    if (this.createFolderModal) this.createFolderModal.style.display = 'flex';
    this.syncModalScrollLock();
    if (this.newFolderNameInput) this.newFolderNameInput.focus();
  }

  hideFolderModal() {
    if (this.createFolderModal) this.createFolderModal.style.display = 'none';
    this.syncModalScrollLock();
    if (this.newFolderNameInput) this.newFolderNameInput.value = '';
  }

  showEditFolderModal() {
    const currentFolder = this.folders.find(f => f.id === this.activeFolderId);
    if (!currentFolder || currentFolder.id === 'all' || currentFolder.id === 'f_favorites' || currentFolder.id === 'f_sueltas') return;

    if (this.editFolderNameInput) this.editFolderNameInput.value = currentFolder.name;
    if (this.editFolderModal) this.editFolderModal.style.display = 'flex';
    this.syncModalScrollLock();
    if (this.editFolderNameInput) this.editFolderNameInput.focus();
  }

  hideEditFolderModal() {
    if (this.editFolderModal) this.editFolderModal.style.display = 'none';
    this.syncModalScrollLock();
    if (this.editFolderNameInput) this.editFolderNameInput.value = '';
  }

  saveFolderEdits() {
    if (!this.editFolderNameInput) return;
    const newName = this.editFolderNameInput.value.trim();
    if (!newName) return;

    const folder = this.folders.find(f => f.id === this.activeFolderId);
    if (folder) {
      folder.name = newName;
      StorageManager.saveFolders(this.folders);
      this.autoSyncDiskFile();
      this.hideEditFolderModal();
      this.renderFolders();
      this.render();
    }
  }

  deleteActiveFolder() {
    const folder = this.folders.find(f => f.id === this.activeFolderId);
    if (!folder || folder.id === 'all' || folder.id === 'f_favorites' || folder.id === 'f_sueltas') return;

    this.showConfirmDialog(
      'Eliminar Carpeta',
      `¿Eliminar la carpeta "${folder.name}"? Sus voces se moverán a "Voces Sueltas".`,
      () => {
        this.voices.forEach(v => {
          if (v.folderId === folder.id) {
            v.folderId = 'f_sueltas';
          }
        });

        this.folders = this.folders.filter(f => f.id !== folder.id);
        StorageManager.saveFolders(this.folders);
        StorageManager.saveVoices(this.voices);
        this.autoSyncDiskFile();

        this.activeFolderId = 'all';
        this.renderFolders();
        this.render();
      }
    );
  }

  saveNewFolder() {
    if (!this.newFolderNameInput) return;
    const name = this.newFolderNameInput.value.trim();
    if (!name) return;

    const newFolder = {
      id: 'f_' + Date.now(),
      name
    };

    this.folders.push(newFolder);
    StorageManager.saveFolders(this.folders);
    this.autoSyncDiskFile();
    this.activeFolderId = newFolder.id;
    this.hideFolderModal();
    this.renderFolders();
    this.render();
  }

  async linkDiskFile() {
    if ('showOpenFilePicker' in window) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{
            description: 'Archivo de Base de Datos JSON',
            accept: { 'application/json': ['.json'] }
          }],
          multiple: false
        });
        this.fileHandle = handle;
        if (this.linkDiskFileBtn) {
          this.linkDiskFileBtn.style.background = '#22c55e';
          this.linkDiskFileBtn.style.borderColor = '#22c55e';
          this.linkDiskFileBtn.title = '¡Archivo voices.json vinculado en tu PC! Se auto-guardará en tiempo real.';
        }
        await this.autoSyncDiskFile();
        alert('¡Archivo voices.json de tu PC vinculado con éxito! Cada cambio se escribirá automáticamente en tu disco duro.');
      } catch (err) {
        if (err.name !== 'AbortError') {
          alert('No se pudo vincular el archivo: ' + err.message);
        }
      }
    } else {
      alert('Tu navegador no admite sincronización directa en tiempo real. Usa los botones de Exportar e Importar.');
    }
  }

  async autoSyncDiskFile() {
    const data = cloneSnapshot({ folders: this.folders, voices: this.voices, settings: this.settings });
    this.setCloudStatus('pending', 'Guardando en Supabase…');
    const cloudSave = this.cloud.save(data);
    const backupSave = this.fileHandle ? (async () => {
      const writable = await this.fileHandle.createWritable();
      await writable.write(JSON.stringify(data, null, 2)); await writable.close();
    })().catch(error => error) : Promise.resolve(null);
    try {
      const result = await cloudSave;
      if (!this.cloud.pending && !this.cloud.unsaved) { this.setCloudStatus('online', 'Guardado en Supabase'); this.setCloudNotice(''); this.reportCacheWarning(result); }
    } catch (error) { this.reportCloudError(error); }
    const backupError = await backupSave;
    if (backupError) this.setCloudNotice('Falló la copia opcional en disco. Comprueba el indicador del guardado online.');
  }

  exportData() {
    const data = {
      folders: this.folders,
      voices: this.voices,
      settings: this.settings
    };

    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'voices.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  importData(file) {
    if (!file || file.size > 25 * 1024 * 1024) { alert('El respaldo debe ser un JSON de menos de 25 MB.'); return; }
    const reader = new FileReader();
    const importGeneration = this.cloud.generation;
    const importChangeSerial = this.cloud.changeSerial;
    const importRevision = this.cloud.revision;
    reader.onload = async event => {
      try {
        const json = JSON.parse(event.target.result);
        const voices = Array.isArray(json) ? json : json.voices;
        const folders = Array.isArray(json) ? DEFAULT_FOLDERS : (json.folders || DEFAULT_FOLDERS);
        if (!Array.isArray(voices) || !Array.isArray(folders) || voices.some(voice => !voice || typeof voice.id !== 'string' || !voice.id || typeof voice.title !== 'string' || !safeAssetUrl(voice.url))) throw new Error('El archivo no tiene una biblioteca de voces válida con enlaces HTTPS.');
        if (new Set(voices.map(voice => voice.id)).size !== voices.length || folders.some(folder => !folder || typeof folder.id !== 'string' || typeof folder.name !== 'string')) throw new Error('Hay identificadores repetidos o carpetas no válidas.');
        // Legacy backups may embed cropped images. Move them to Storage before
        // importing metadata, so new database rows contain stable refs only.
        for (const voice of voices) {
          if (voice.coverImage?.startsWith('data:') && !voice.coverStoragePath) Object.assign(voice, await prepareCover(voice.coverImage, true, null, image => this.cloud.uploadCover(image)));
        }
        if (!this.cloud.connected || importGeneration !== this.cloud.generation || importChangeSerial !== this.cloud.changeSerial || importRevision !== this.cloud.revision) throw new Error('La sesión o biblioteca cambió durante la importación. Vuelve a importar el respaldo.');
        this.applyCloudSnapshot({ snapshot: { folders, voices, settings: json.settings || this.settings } });
        this.activeFolderId = 'all';
        this.autoSyncDiskFile();
        this.renderFolders(); this.render();
        this.setCloudNotice('Respaldo importado. Comprueba que el indicador confirme el guardado online.');
      } catch (error) { alert('Error al leer el archivo JSON: ' + error.message); }
      finally { if (this.importFileInput) this.importFileInput.value = ''; }
    };
    reader.readAsText(file);
  }

  processImageFile(fileOrBlob) {
    if (!fileOrBlob || !/^image\/(png|jpeg|webp|gif)$/.test(fileOrBlob.type) || fileOrBlob.size > 10 * 1024 * 1024) {
      if (this.modalSaveError) this.modalSaveError.textContent = 'Sube una imagen PNG, JPEG, WebP o GIF de menos de 10 MB; se recortará a PNG.';
      return;
    }
    const serial = ++this.imageReadSerial;
    this.isCropping = true;
    if (this.saveVoiceBtn) this.saveVoiceBtn.disabled = true;
    const reader = new FileReader();
    reader.onload = (e) => {
      if (serial !== this.imageReadSerial) return;
      this.coverChanged = true;
      this.loadAndCropSquare(e.target.result);
    };
    reader.onerror = () => { if (serial === this.imageReadSerial) { this.isCropping = false; if (this.saveVoiceBtn) this.saveVoiceBtn.disabled = this.isSavingVoice; this.modalSaveError.textContent = 'No se pudo leer la imagen.'; } };
    reader.readAsDataURL(fileOrBlob);
  }

  loadAndCropSquare(imageSrc) {
    if (!this.cropCanvas) return;
    const serial = ++this.imageReadSerial;
    imageSrc = safeAssetUrl(imageSrc, 'image');
    if (!imageSrc) { this.isCropping = false; if (this.saveVoiceBtn) this.saveVoiceBtn.disabled = this.isSavingVoice; return; }
    this.isCropping = true;
    if (this.saveVoiceBtn) this.saveVoiceBtn.disabled = true;
    const img = new Image();
    this.currentCroppedImage = imageSrc;
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (serial !== this.imageReadSerial) return;
      const canvas = this.cropCanvas;
      const ctx = canvas.getContext('2d');
      canvas.width = 160;
      canvas.height = 160;

      const minDim = Math.min(img.width, img.height);
      const sx = (img.width - minDim) / 2;
      const sy = (img.height - minDim) / 2;

      ctx.clearRect(0, 0, 160, 160);
      ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, 160, 160);

      try { this.currentCroppedImage = canvas.toDataURL('image/png'); } catch { this.currentCroppedImage = imageSrc; }
      this.cropCanvas.style.display = 'block';
      if (this.imagePlaceholder) this.imagePlaceholder.style.display = 'none';
      if (this.removeImgBtn) this.removeImgBtn.style.display = 'inline-flex';
      this.isCropping = false; if (this.saveVoiceBtn) this.saveVoiceBtn.disabled = this.isSavingVoice;
    };
    img.onerror = () => { if (serial === this.imageReadSerial) { this.currentCroppedImage = imageSrc; this.isCropping = false; if (this.saveVoiceBtn) this.saveVoiceBtn.disabled = this.isSavingVoice; } };
    img.src = imageSrc;
  }

  clearCroppedImage() {
    this.imageReadSerial += 1; this.coverChanged = true; this.isCropping = false;
    if (this.saveVoiceBtn) this.saveVoiceBtn.disabled = this.isSavingVoice;
    this.currentCroppedImage = '';
    if (this.cropCanvas) this.cropCanvas.style.display = 'none';
    if (this.imagePlaceholder) this.imagePlaceholder.style.display = 'flex';
    if (this.removeImgBtn) this.removeImgBtn.style.display = 'none';
    if (this.modalFileInput) this.modalFileInput.value = '';
  }

  openNewTab() {
    if (isExtensionContext()) {
      chrome.runtime.sendMessage({ action: 'open_tab' }, (response) => {
        if (!response || !response.success) {
          window.open(window.location.href, '_blank');
        }
      });
    } else {
      window.open(window.location.href, '_blank');
    }
  }

  showModal() {
    this.modalSession += 1;
    if (this.modalSaveError) this.modalSaveError.textContent = '';
    this.editingVoiceId = null;
    if (this.modalNotesInput) this.modalNotesInput.value = '';
    if (this.modalTitle) this.modalTitle.textContent = 'Agregar Nueva Voz';
    if (this.modalTitleInput) this.modalTitleInput.value = '';
    if (this.modalUrlInput) this.modalUrlInput.value = '';

    if (this.modalFolderSelect && this.activeFolderId !== 'all') {
      this.modalFolderSelect.value = this.activeFolderId;
    }

    this.clearCroppedImage();
    this.coverChanged = false;
    if (this.addModal) this.addModal.style.display = 'flex';
    this.syncModalScrollLock();
    if (this.modalTitleInput) this.modalTitleInput.focus();
  }

  showEditModal(voice) {
    this.modalSession += 1;
    if (this.modalSaveError) this.modalSaveError.textContent = '';
    this.editingVoiceId = voice.id;
    if (this.modalNotesInput) this.modalNotesInput.value = voice.notes || '';
    if (this.modalTitle) this.modalTitle.textContent = 'Editar Voz';
    if (this.modalTitleInput) this.modalTitleInput.value = voice.title;
    if (this.modalUrlInput) this.modalUrlInput.value = voice.url;
    if (this.modalFolderSelect && voice.folderId) {
      this.modalFolderSelect.value = voice.folderId;
    }

    if (voice.coverImage) {
      this.loadAndCropSquare(voice.coverImage);
    } else {
      this.clearCroppedImage();
    }

    this.coverChanged = false;
    if (this.addModal) this.addModal.style.display = 'flex';
    this.syncModalScrollLock();
    if (this.modalTitleInput) this.modalTitleInput.focus();
  }

  hideModal() {
    this.modalSession += 1;
    if (this.addModal) this.addModal.style.display = 'none';
    this.syncModalScrollLock();
    this.editingVoiceId = null;
    if (this.modalTitleInput) this.modalTitleInput.value = '';
    if (this.modalUrlInput) this.modalUrlInput.value = '';
    this.clearCroppedImage();
  }

  async fetchFishAudioInfo(modelId) {
    if (!/^[a-zA-Z0-9_-]{12,64}$/.test(modelId)) return null;
    if (this.metadataRequests.has(modelId)) return this.metadataRequests.get(modelId);
    const request = (async () => {
      try {
        const data = await this.cloud.request('resolve_fish_audio', { ...this.cloud.identity(), modelId });
        if (!data || typeof data !== 'object') return null;
        const sample = safeAssetUrl(data.samples?.[0]?.audio || data.audioUrl, 'audio');
        const rawCover = data.cover_image || data.coverImage || '';
        const cover = safeAssetUrl(rawCover.startsWith('https://') ? rawCover : rawCover ? 'https://public-platform.r2.fish.audio/' + rawCover : '', 'image');
        return { title: String(data.title || ''), sampleAudio: sample, coverImage: cover };
      } catch { return null; }
    })();
    this.metadataRequests.set(modelId, request);
    try { return await request; } finally { this.metadataRequests.delete(modelId); }
  }

  async saveVoiceFromModal() {
    if (!this.cloud.connected || this.isSavingVoice || this.isCropping) return;
    const operationGeneration = this.cloud.generation;
    const modalSession = this.modalSession;
    const editingId = this.editingVoiceId;
    const previous = editingId ? this.voices.find(voice => voice.id === editingId) : null;
    let title = this.modalTitleInput ? this.modalTitleInput.value.trim() : '';
    const url = this.modalUrlInput ? this.modalUrlInput.value.trim() : '';
    const notes = this.modalNotesInput ? this.modalNotesInput.value.trim() : (previous?.notes || '');
    const folderId = this.modalFolderSelect ? this.modalFolderSelect.value || 'f_sueltas' : 'f_sueltas';
    const crop = this.currentCroppedImage;
    const coverChanged = this.coverChanged;
    if (!safeAssetUrl(url)) { this.modalSaveError.textContent = 'Introduce un enlace HTTPS válido.'; return; }
    this.isSavingVoice = true;
    if (this.saveVoiceBtn) { this.saveVoiceBtn.disabled = true; this.saveVoiceBtn.textContent = 'Guardando…'; }
    this.modalSaveError.textContent = '';
    const stillCurrent = () => this.cloud.connected && this.cloud.generation === operationGeneration && this.modalSession === modalSession;
    try {
      // Upload a new crop before mutating the library. Failed uploads leave the
      // modal and crop intact, and never write base64 into a new voice record.
      const cover = await prepareCover(crop, coverChanged, previous, image => this.cloud.uploadCover(image));
      if (!stillCurrent()) return;
      let audioUrl = previous && previous.url === url ? previous.audioUrl : url;
      const match = url.match(/fish\.audio\/(?:[a-z]{2}\/)?m\/([a-f0-9]{32})/i) || url.match(/m\/([a-f0-9]{32})/i);
      if (match && (!previous || previous.url !== url || !previous.audioUrl)) {
        const info = await this.fetchFishAudioInfo(match[1]);
        if (!stillCurrent()) return;
        if (info) { if (!title && info.title) title = info.title; if (info.sampleAudio) audioUrl = info.sampleAudio; }
      }
      if (!stillCurrent()) return;
      if (!title) title = 'Voz Fish Audio';
      if (editingId) {
        const index = this.voices.findIndex(voice => voice.id === editingId);
        if (index < 0) return;
        const oldBase = this.parseVoiceVersion(this.voices[index].title).baseName.toLowerCase();
        const newBase = this.parseVoiceVersion(title).baseName.toLowerCase();
        Object.assign(this.voices[index], { title, url, audioUrl, notes, folderId, ...cover });
        this.voices.forEach((voice, index2) => {
          if (index2 !== index) {
            const base = this.parseVoiceVersion(voice.title).baseName.toLowerCase();
            if (base === oldBase || base === newBase) voice.folderId = folderId;
          }
        });
        if (this.currentPlayingId === editingId) this.pauseAudio(editingId);
        this.audioPlayers.delete(editingId);
      } else {
        const base = this.parseVoiceVersion(title).baseName.toLowerCase();
        const sibling = this.voices.find(voice => this.parseVoiceVersion(voice.title).baseName.toLowerCase() === base);
        const finalFolderId = sibling && folderId === 'f_sueltas' && sibling.folderId !== 'f_sueltas' ? sibling.folderId : folderId;
        this.voices.unshift({ id: 'v_' + Date.now(), title, url, audioUrl, notes, folderId: finalFolderId, ...cover });
        if (sibling && folderId !== 'f_sueltas') this.voices.forEach(voice => { if (this.parseVoiceVersion(voice.title).baseName.toLowerCase() === base) voice.folderId = folderId; });
      }
      StorageManager.saveVoices(this.voices);
      this.autoSyncDiskFile();
      this.hideModal(); this.renderFolders(); this.render();
    } catch (error) {
      if (stillCurrent()) {
        this.modalSaveError.textContent = error.code === 'RATE_LIMIT' ? 'No se pudo subir la portada: espera al reinicio de la cuota y vuelve a guardar. El recorte sigue aquí.' : 'No se pudo subir o guardar la portada. El recorte sigue aquí; vuelve a intentarlo.';
        if (error.code === 'RATE_LIMIT') this.reportCloudError(error);
      }
    } finally {
      this.isSavingVoice = false;
      if (this.saveVoiceBtn) { this.saveVoiceBtn.disabled = !!this.isCropping; this.saveVoiceBtn.textContent = 'Guardar Voz'; }
    }
  }

  showConfirmDialog(title, message, onConfirm) {
    if (!this.confirmModal) return;
    if (this.confirmModalTitle) this.confirmModalTitle.textContent = title || 'Confirmar Acción';
    if (this.confirmModalText) this.confirmModalText.textContent = message || '¿Estás seguro de continuar?';
    this.onConfirmCallback = onConfirm;
    this.confirmModal.style.display = 'flex';
    this.syncModalScrollLock();
  }

  hideConfirmDialog() {
    if (this.confirmModal) this.confirmModal.style.display = 'none';
    this.syncModalScrollLock();
    this.onConfirmCallback = null;
  }

  deleteVoice(id) {
    const voice = this.voices.find(v => v.id === id);
    const title = voice ? voice.title : 'esta voz';

    this.showConfirmDialog(
      'Eliminar Voz',
      `¿Estás seguro de que deseas eliminar "${title}"?`,
      () => {
        if (this.currentPlayingId === id) {
          this.pauseAudio(id);
        }
        this.audioPlayers.delete(id);
        this.voices = this.voices.filter(v => v.id !== id);
        StorageManager.saveVoices(this.voices);
        this.autoSyncDiskFile();
        this.renderFolders();
        this.render();
      }
    );
  }

  changeVoiceFolder(voiceId, newFolderId) {
    const voice = this.voices.find(v => v.id === voiceId);
    if (voice) {
      const { baseName } = this.parseVoiceVersion(voice.title);
      const baseKey = baseName.toLowerCase();

      this.voices.forEach(v => {
        if (v.id === voiceId || (v.title && this.parseVoiceVersion(v.title).baseName.toLowerCase() === baseKey)) {
          v.folderId = newFolderId;
        }
      });

      StorageManager.saveVoices(this.voices);
      this.autoSyncDiskFile();
      this.renderFolders();
      this.render();
    }
  }

  setShowNotes(show) {
    show = Boolean(show);
    if ((this.settings.showNotes !== false) === show) return;
    this.settings.showNotes = show;
    StorageManager.saveSettings(this.settings);
    this.autoSyncDiskFile();
    this.render();
  }

  showSettingsModal() {
    if (!this.settingsModal) return;
    this.settingsModal.style.display = 'flex';
    this.syncModalScrollLock();
    if (this.toggleQuickFolderBadge) {
      this.toggleQuickFolderBadge.checked = !!this.settings.showQuickFolderBadge;
    }
    if (this.toggleSidebarFolders) {
      this.toggleSidebarFolders.checked = this.settings.showSidebarFolders !== false;
    }
    if (this.toggleShowNotes) this.toggleShowNotes.checked = this.settings.showNotes !== false;
    if (this.toggleMultiSelectMode) this.toggleMultiSelectMode.checked = this.isMultiSelectActive;
  }

  hideSettingsModal() {
    if (this.settingsModal) this.settingsModal.style.display = 'none';
    this.syncModalScrollLock();
  }

  saveSettingsFromModal() {
    const next = {
      showQuickFolderBadge: this.toggleQuickFolderBadge ? this.toggleQuickFolderBadge.checked : !!this.settings.showQuickFolderBadge,
      showSidebarFolders: this.toggleSidebarFolders ? this.toggleSidebarFolders.checked : this.settings.showSidebarFolders !== false,
      showNotes: this.toggleShowNotes ? this.toggleShowNotes.checked : this.settings.showNotes !== false
    };
    const changed = next.showQuickFolderBadge !== !!this.settings.showQuickFolderBadge
      || next.showSidebarFolders !== (this.settings.showSidebarFolders !== false)
      || next.showNotes !== (this.settings.showNotes !== false);
    if (changed) {
      Object.assign(this.settings, next);
      StorageManager.saveSettings(this.settings);
      this.autoSyncDiskFile();
      this.applySettings(); this.render();
    }
    this.hideSettingsModal();
  }

  applySettings() {
    const sidebar = document.getElementById('sidebarFolders');
    const folderSec = document.querySelector('.folder-section');

    const show = this.settings.showSidebarFolders !== false;
    if (sidebar) sidebar.style.display = show ? '' : 'none';
    if (folderSec) folderSec.style.display = show ? '' : 'none';
  }

  setMultiSelectMode(active) {
    this.isMultiSelectActive = active;
    if (this.toggleMultiSelectBtn) {
      this.toggleMultiSelectBtn.classList.toggle('active', active);
    }
    if (this.toggleMultiSelectMode) {
      this.toggleMultiSelectMode.checked = active;
    }
    if (!active) {
      this.selectedVoiceIds.clear();
    }
    this.updateBatchBarUI();
    this.render();
  }

  updateBatchBarUI() {
    if (!this.batchActionBar) return;
    if (this.isMultiSelectActive) {
      this.batchActionBar.style.display = 'flex';
      if (this.batchCountText) {
        this.batchCountText.textContent = `${this.selectedVoiceIds.size} seleccionadas`;
      }
      if (this.batchFolderSelect) {
        this.batchFolderSelect.innerHTML = '';
        const defaultOpt = document.createElement('option');
        defaultOpt.value = 'f_sueltas';
        defaultOpt.textContent = 'Voces Sueltas';
        this.batchFolderSelect.appendChild(defaultOpt);

        this.folders.forEach(f => {
          if (f.id !== 'all' && f.id !== 'f_favorites' && f.id !== 'f_sueltas') {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.textContent = f.name;
            this.batchFolderSelect.appendChild(opt);
          }
        });
      }
    } else {
      this.batchActionBar.style.display = 'none';
    }
  }

  toggleSelectAllBatch() {
    const query = this.searchInput ? this.searchInput.value.toLowerCase() : '';
    const filtered = this.voices.filter(v => {
      const matchesSearch = v.title.toLowerCase().includes(query);
      let matchesFolder = false;
      if (this.activeFolderId === 'all') matchesFolder = true;
      else if (this.activeFolderId === 'f_favorites') matchesFolder = !!v.isFavorite;
      else matchesFolder = v.folderId === this.activeFolderId;
      return matchesSearch && matchesFolder;
    });

    const allFilteredSelected = filtered.length > 0 && filtered.every(v => this.selectedVoiceIds.has(v.id));

    if (allFilteredSelected) {
      filtered.forEach(v => this.selectedVoiceIds.delete(v.id));
    } else {
      filtered.forEach(v => this.selectedVoiceIds.add(v.id));
    }

    this.updateBatchBarUI();
    this.render();
  }

  applyBatchMove() {
    if (this.selectedVoiceIds.size === 0) return;
    const targetFolderId = this.batchFolderSelect ? this.batchFolderSelect.value : 'f_sueltas';

    this.selectedVoiceIds.forEach(id => {
      const v = this.voices.find(voice => voice.id === id);
      if (v) v.folderId = targetFolderId;
    });

    StorageManager.saveVoices(this.voices);
    this.autoSyncDiskFile();
    this.selectedVoiceIds.clear();
    this.renderFolders();
    this.render();
    this.updateBatchBarUI();
  }


  parseVoiceVersion(title) {
    if (!title) return { baseName: 'Voz Sin Nombre', versionTag: 'V1' };
    let cleaned = title.trim();

    // Normalizar artículos iniciales para agrupar "El Narrador" con "Narrador v2"
    let withoutArticle = cleaned.replace(/^(el|la|los|las)\s+/i, '');

    // Coincidencia con v2, v3, v.2, version 2, versión 2, - v2, _v2, etc.
    const vRegex = /^(.*?)(?:\s+|-|_|\()(?:v|v\.|version|versión)\s*(\d+)\)?$/i;
    const vMatch = withoutArticle.match(vRegex);
    if (vMatch && vMatch[1].trim().length > 0) {
      return {
        baseName: vMatch[1].trim(),
        versionTag: 'V' + vMatch[2]
      };
    }

    // Coincidencia con paréntesis como "Kinger (Español Latino)" -> Base: "Kinger"
    const parenRegex = /^(.*?)\s*\((.*?)\)$/;
    const parenMatch = withoutArticle.match(parenRegex);
    if (parenMatch && parenMatch[1].trim().length > 0) {
      return {
        baseName: parenMatch[1].trim(),
        versionTag: parenMatch[2].trim()
      };
    }

    return {
      baseName: withoutArticle,
      versionTag: 'V1'
    };
  }

  groupFilteredVoices(filtered) {
    const groupsMap = new Map();

    filtered.forEach(voice => {
      const { baseName, versionTag } = this.parseVoiceVersion(voice.title);
      const key = baseName.toLowerCase();

      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          baseName: baseName,
          voices: []
        });
      }

      groupsMap.get(key).voices.push({
        ...voice,
        versionTag: versionTag
      });
    });

    const groups = Array.from(groupsMap.values());

    groups.sort((a, b) => {
      const getMaxId = (g) => Math.max(...g.voices.map(v => parseInt(String(v.id).replace(/\D/g, '')) || 0));
      const maxA = getMaxId(a);
      const maxB = getMaxId(b);
      return this.sortOrder === 'desc' ? maxB - maxA : maxA - maxB;
    });

    return groups;
  }

  render() {
    if (!this.voicesList) return;
    const query = this.searchInput ? this.searchInput.value.toLowerCase() : '';

    let filtered = this.voices.filter(v => {
      const matchesSearch = v.title.toLowerCase().includes(query);
      let matchesFolder = false;
      if (this.activeFolderId === 'all') {
        matchesFolder = true;
      } else if (this.activeFolderId === 'f_favorites') {
        matchesFolder = !!v.isFavorite;
      } else {
        matchesFolder = v.folderId === this.activeFolderId;
      }
      return matchesSearch && matchesFolder;
    });

    const groups = this.groupFilteredVoices(filtered);

    if (this.totalCountEl) {
      this.totalCountEl.textContent = `${filtered.length} voces`;
    }

    if (groups.length === 0) {
      this.voicesList.innerHTML = '';
      if (this.emptyState) this.emptyState.style.display = 'block';
      return;
    }

    if (this.emptyState) this.emptyState.style.display = 'none';
    this.voicesList.innerHTML = '';

    groups.forEach(group => {
      if (group.voices.length === 1) {
        const el = this.createCardElement(group.voices[0]);
        this.voicesList.appendChild(el);
      } else {
        const el = this.createGroupCard(group);
        this.voicesList.appendChild(el);
      }
    });
  }

  createCard(voice) {
    return this.createCardElement(voice);
  }

  createGroupCard(group) {
    const groupVoices = group.voices;
    groupVoices.sort((a, b) => {
      const numA = parseInt(a.versionTag.replace(/\D/g, '')) || 1;
      const numB = parseInt(b.versionTag.replace(/\D/g, '')) || 1;
      return numA - numB;
    });

    const mainVoice = groupVoices[0];
    const subVoices = groupVoices.slice(1);

    const container = document.createElement('div');
    container.className = 'voice-item-group-container';

    const mainCard = this.createCardElement(mainVoice, {
      isGroupHeader: true,
      baseName: group.baseName,
      subCount: groupVoices.length
    });

    container.appendChild(mainCard);

    const subContainer = document.createElement('div');
    subContainer.className = 'group-versions-panel';
    subContainer.style.display = 'none';

    subVoices.forEach(subVoice => {
      const subCard = this.createCardElement(subVoice, {
        isSubVersion: true
      });
      subContainer.appendChild(subCard);
    });

    container.appendChild(subContainer);

    const toggleBtn = mainCard.querySelector('.expand-group-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isExpanded = subContainer.style.display !== 'none' && !subContainer.classList.contains('collapsing');

        if (isExpanded) {
          toggleBtn.classList.remove('expanded');
          toggleBtn.setAttribute('title', `Desplegar otras versiones (${groupVoices.length} versiones)`);
          subContainer.classList.add('collapsing');
          setTimeout(() => {
            subContainer.style.display = 'none';
            subContainer.classList.remove('collapsing');
          }, 290);
        } else {
          subContainer.style.display = 'flex';
          subContainer.classList.remove('collapsing');
          toggleBtn.classList.add('expanded');
          toggleBtn.setAttribute('title', 'Ocultar versiones');
        }
      });
    }

    return container;
  }

  updateSignedCovers(freshVoices) {
    let changed = false;
    for (const fresh of freshVoices) {
      const current = this.voices.find(voice => voice.id === fresh.id);
      if (current && current.coverStoragePath && current.coverStoragePath === fresh.coverStoragePath && fresh.coverImage && fresh.coverImage !== current.coverImage) {
        current.coverImage = safeAssetUrl(fresh.coverImage, 'image'); current.coverExpiresAt = fresh.coverExpiresAt; changed = true;
      }
    }
    if (changed) this.render();
  }

  refreshExpiredCover(voice) {
    if (!voice.coverStoragePath || this.coverRefreshIds.has(voice.id) || this.cloud.pending || this.cloud.unsaved || !this.cloud.connected) return;
    this.coverRefreshIds.add(voice.id);
    this.setCloudNotice('Una portada necesita renovar su enlace. Pulsa Actualizar cuando quieras consultarla en Supabase.', false, true);
  }

  bindNotesReadingControls(notes) {
    if (!notes?.addEventListener) return;
    notes.addEventListener('keydown', event => {
      if (event.target !== notes || event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key;
      if (event.shiftKey && key !== ' ' && key !== 'Spacebar') return;
      const maximum = Math.max(0, notes.scrollHeight - notes.clientHeight);
      const page = Math.max(40, Math.round(notes.clientHeight * .9));
      let next;
      if (key === 'ArrowDown') next = notes.scrollTop + 40;
      else if (key === 'ArrowUp') next = notes.scrollTop - 40;
      else if (key === 'PageDown') next = notes.scrollTop + page;
      else if (key === 'PageUp') next = notes.scrollTop - page;
      else if (key === 'Home') next = 0;
      else if (key === 'End') next = maximum;
      else if (key === ' ' || key === 'Spacebar') next = notes.scrollTop + (event.shiftKey ? -page : page);
      else return;
      event.preventDefault();
      notes.scrollTop = Math.min(maximum, Math.max(0, next));
    });
  }

  createCardElement(voice, options = {}) {
    const isSelected = this.selectedVoiceIds.has(voice.id);
    const item = document.createElement('div');
    item.className = options.isSubVersion
      ? `voice-item sub-version-item ${isSelected ? 'selected' : ''}`
      : `voice-item ${isSelected ? 'selected' : ''}`;
    item.dataset.id = voice.id;

    let checkboxHtml = '';
    if (this.isMultiSelectActive) {
      checkboxHtml = `
        <div class="card-checkbox-wrapper">
          <input type="checkbox" class="card-checkbox" ${isSelected ? 'checked' : ''}>
        </div>
      `;
    }

    const isPlaying = this.currentPlayingId === voice.id;

    const hasValidCover = voice.coverImage && voice.coverImage.trim() !== '' && !voice.coverImage.startsWith('images/v_') && !voice.coverImage.includes('icon128.png');
    const svgPlaceholder = `<div class="voice-cover-large-placeholder"><svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line><line x1="8" y1="22" x2="16" y2="22"></line></svg></div>`;
    const coverHtml = hasValidCover
      ? `<img src="${this.escape(safeAssetUrl(voice.coverImage, 'image'))}" class="voice-cover-large" alt="Portada">`
      : svgPlaceholder;

    let toggleBtnHtml = '';
    if (options.isGroupHeader) {
      toggleBtnHtml = `
        <button class="expand-group-btn" title="Desplegar otras versiones (${options.subCount} versiones)">
          <span class="version-count-badge">${options.subCount} vers.</span>
          <svg class="chevron-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
      `;
    }

    const titleText = options.isGroupHeader ? options.baseName : voice.title;

    let folderSelectHtml = '';
    if (this.settings.showQuickFolderBadge) {
      let folderOptionsHtml = `
        <option value="f_sueltas" ${(voice.folderId === 'f_sueltas' || !voice.folderId) ? 'selected' : ''}>Voces Sueltas</option>
      `;

      this.folders.forEach(f => {
        if (f.id !== 'all' && f.id !== 'f_favorites' && f.id !== 'f_sueltas') {
          folderOptionsHtml += `
            <option value="${this.escape(f.id)}" ${voice.folderId === f.id ? 'selected' : ''}>${this.escape(f.name)}</option>
          `;
        }
      });

      const currentFolderName = (this.folders.find(f => f.id === voice.folderId) || { name: 'Voces Sueltas' }).name;

      folderSelectHtml = `
        <div class="quick-folder-badge" title="Mover a otra carpeta rápidamente">
          <svg class="folder-svg-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          <span class="quick-folder-label">${this.escape(currentFolderName)}</span>
          <svg class="chevron-svg-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
          <select class="quick-folder-select">
            ${folderOptionsHtml}
          </select>
        </div>
      `;
    }

    const notesText = typeof voice.notes === 'string' ? voice.notes.trim() : '';
    const notesHtml = this.settings.showNotes !== false && notesText
      ? `<div class="voice-notes" role="note" aria-label="Notas de esta voz"><span class="voice-notes-label">Notas</span><p class="voice-notes-text" tabindex="0">${this.escape(notesText)}</p></div>`
      : '';

    item.innerHTML = `
      ${checkboxHtml}
      <div class="voice-cover-side">
        ${coverHtml}
      </div>

      <div class="voice-content-side">
        <div class="voice-item-header">
          <span class="voice-item-title">${this.escape(titleText)}</span>
          <div class="header-btns-right">
            ${folderSelectHtml}
            <button class="icon-fav-btn ${voice.isFavorite ? 'active' : ''}" title="${voice.isFavorite ? 'Quitar de Favoritas' : 'Marcar como Favorita'}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="${voice.isFavorite ? '#ffc107' : 'none'}" stroke="${voice.isFavorite ? '#ffc107' : 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
            </button>
            <button class="icon-edit-btn edit-btn" title="Editar esta voz">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            ${toggleBtnHtml}
          </div>
        </div>

        ${notesHtml}

        <div class="player-row">
          <button class="play-toggle-btn" title="${isPlaying ? 'Pausar' : 'Reproducir'}">
            ${isPlaying ? '❚❚' : '▶'}
          </button>
          <div class="timeline">
            <span class="time-str cur-time">0:00</span>
            <input type="range" class="seek-bar" value="0" min="0" max="100">
            <span class="time-str dur-time">0:00</span>
          </div>
        </div>

        <div class="item-actions">
          <div class="left-actions">
            <button class="action-link copy-btn">Copiar Enlace</button>
            <a href="${this.escape(safeAssetUrl(voice.url))}" target="_blank" rel="noopener noreferrer" class="action-link open-url-btn">Ir al Enlace</a>
          </div>
          <button class="action-link danger del-btn">Eliminar</button>
        </div>
      </div>
    `;

    item.querySelector('img')?.addEventListener('error', event => { event.target.parentElement.innerHTML = svgPlaceholder; this.refreshExpiredCover(voice); }, { once: true });
    this.bindNotesReadingControls(item.querySelector('.voice-notes-text'));
    this.bindCardControls(item, voice);
    return item;
  }

  bindCardControls(item, voice) {
    const playBtn = item.querySelector('.play-toggle-btn');
    const seekBar = item.querySelector('.seek-bar');
    const curTimeEl = item.querySelector('.cur-time');
    const durTimeEl = item.querySelector('.dur-time');
    const copyBtn = item.querySelector('.copy-btn');
    const editBtn = item.querySelector('.edit-btn');
    const delBtn = item.querySelector('.del-btn');
    const favBtn = item.querySelector('.icon-fav-btn');
    const cardCheckbox = item.querySelector('.card-checkbox');

    if (cardCheckbox) {
      cardCheckbox.addEventListener('change', (e) => {
        e.stopPropagation();
        if (e.target.checked) {
          this.selectedVoiceIds.add(voice.id);
          item.classList.add('selected');
        } else {
          this.selectedVoiceIds.delete(voice.id);
          item.classList.remove('selected');
        }
        this.updateBatchBarUI();
      });
    }

    if (favBtn) {
      favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleFavorite(voice.id);
      });
    }

    const folderSelect = item.querySelector('.quick-folder-select');
    if (folderSelect) {
      folderSelect.addEventListener('change', (e) => {
        e.stopPropagation();
        this.changeVoiceFolder(voice.id, e.target.value);
      });
      folderSelect.addEventListener('click', (e) => e.stopPropagation());
    }

    const streamSource = this.getPlaybackSource(voice);

    let audio = this.audioPlayers.get(voice.id);
    const sourceKey = this.playbackSourceKey(voice);
    if (!audio || audio.voiceSourceKey !== sourceKey) {
      if (audio) audio.pause();
      audio = new Audio();
      audio.voiceSourceKey = sourceKey;
      audio.preload = 'metadata'; // Read duration without downloading all samples.
      if (streamSource) {
        audio.src = streamSource;
      }
      this.audioPlayers.set(voice.id, audio);
    }

    audio.onloadedmetadata = () => {
      durTimeEl.textContent = this.formatTime(audio.duration);
    };

    audio.oncanplaythrough = () => {
      if (audio.duration) {
        durTimeEl.textContent = this.formatTime(audio.duration);
      }
    };

    audio.onplaying = () => {
      if (this.currentPlayingId === voice.id && curTimeEl.textContent === 'Cargando...') {
        curTimeEl.textContent = this.formatTime(audio.currentTime);
      }
    };

    audio.ontimeupdate = () => {
      if (audio.duration) {
        seekBar.value = (audio.currentTime / audio.duration) * 100;
        curTimeEl.textContent = this.formatTime(audio.currentTime);
      }
    };

    audio.onended = () => {
      this.stopSmoothProgressLoop();
      this.currentPlayingId = null;
      playBtn.textContent = '▶';
      seekBar.value = 0;
      seekBar.style.background = '#262626';
      curTimeEl.textContent = '0:00';
    };

    audio.onerror = () => {
      if (this.currentPlayingId === voice.id) {
        this.stopSmoothProgressLoop();
        curTimeEl.textContent = 'Error';
        playBtn.textContent = '▶';
        this.currentPlayingId = null;
      }
    };

    playBtn.addEventListener('click', () => {
      if (this.currentPlayingId === voice.id && !audio.paused) {
        this.pauseAudio(voice.id);
      } else {
        if (this.currentPlayingId && this.currentPlayingId !== voice.id) {
          this.pauseAudio(this.currentPlayingId);
        }
        this.playAudio(voice.id);
      }
    });

    seekBar.addEventListener('input', (e) => {
      if (audio.duration) {
        audio.currentTime = (e.target.value / 100) * audio.duration;
        const percent = (audio.currentTime / audio.duration) * 100;
        seekBar.style.background = `linear-gradient(to right, #ffffff ${percent}%, #262626 ${percent}%)`;
      }
    });

    editBtn.addEventListener('click', () => this.showEditModal(voice));

    delBtn.addEventListener('click', () => this.deleteVoice(voice.id));

    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(voice.url).then(() => {
        copyBtn.textContent = '¡Copiado!';
        setTimeout(() => copyBtn.textContent = 'Copiar Enlace', 1500);
      });
    });
  }

  playbackSourceKey(voice) {
    return JSON.stringify([String(voice.id), voice.url || '', voice.audioUrl || '']);
  }

  getPlaybackSource(voice) {
    const key = this.playbackSourceKey(voice);
    const cached = this.playbackSources?.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    this.playbackSources?.delete(key);
    return safeAssetUrl(voice.audioUrl, 'audio');
  }

  rememberPlaybackSource(voice, url) {
    const source = safeAssetUrl(url, 'audio');
    if (!source) return '';
    if (!this.playbackSources) this.playbackSources = new Map();
    const key = this.playbackSourceKey(voice);
    this.playbackSources.delete(key);
    this.playbackSources.set(key, { url: source, expiresAt: Date.now() + 30 * 60 * 1000 });
    while (this.playbackSources.size > 256) this.playbackSources.delete(this.playbackSources.keys().next().value);
    return source;
  }

  prunePlaybackSources() {
    if (!this.playbackSources) return;
    const liveKeys = new Set(this.voices.map(voice => this.playbackSourceKey(voice)));
    for (const [key, source] of this.playbackSources) {
      if (!liveKeys.has(key) || source.expiresAt <= Date.now()) this.playbackSources.delete(key);
    }
  }

  async playAudio(id) {
    const audio = this.audioPlayers.get(id);
    const voice = this.voices.find(item => item.id === id);
    if (!audio || !voice) return;
    const requestId = (this.playRequestId || 0) + 1;
    const generation = this.cloud.generation;
    this.playRequestId = requestId; this.desiredPlayingId = id;
    const card = document.querySelector(`.voice-item[data-id="${CSS.escape(String(id))}"]`);
    const btn = card?.querySelector('.play-toggle-btn');
    const curTimeEl = card?.querySelector('.cur-time');
    const isCurrent = () => this.playRequestId === requestId && this.desiredPlayingId === id && this.cloud.generation === generation;
    const match = voice.url.match(/m\/([a-zA-Z0-9_]+)/i) || voice.url.match(/([a-f0-9]{12,32})/i);
    let refreshed = false;
    const refresh = async () => {
      if (!match || refreshed) return false;
      refreshed = true;
      this.playbackSources?.delete(this.playbackSourceKey(voice));
      const info = await this.fetchFishAudioInfo(match[1]);
      if (!isCurrent() || !info?.sampleAudio) return false;
      const source = this.rememberPlaybackSource(voice, info.sampleAudio);
      if (!source) return false;
      // Signed Fish Audio samples are transient playback data, not library edits.
      audio.src = source; audio.load();
      return true;
    };
    if (btn) btn.textContent = '...';
    if (curTimeEl) curTimeEl.textContent = 'Cargando...';
    try {
      if (!audio.src) await refresh();
      if (!isCurrent()) return;
      try { await audio.play(); }
      catch (error) {
        if (!isCurrent() || !(await refresh())) throw error;
        await audio.play();
      }
      if (!isCurrent()) { audio.pause(); return; }
      this.currentPlayingId = id; this.startSmoothProgressLoop(id);
      if (btn) btn.textContent = '❚❚';
      if (curTimeEl) curTimeEl.textContent = this.formatTime(audio.currentTime);
    } catch {
      if (!isCurrent()) return;
      this.currentPlayingId = null;
      if (btn) btn.textContent = '▶';
      if (curTimeEl) curTimeEl.textContent = 'Error';
    }
  }

  pauseAudio(id) {
    if (this.desiredPlayingId === id) { this.desiredPlayingId = null; this.playRequestId = (this.playRequestId || 0) + 1; }
    const audio = this.audioPlayers.get(id);
    if (audio) audio.pause();
    this.stopSmoothProgressLoop();
    if (this.currentPlayingId === id) this.currentPlayingId = null;

    const card = document.querySelector(`.voice-item[data-id="${CSS.escape(String(id))}"]`);
    if (card) {
      const btn = card.querySelector('.play-toggle-btn');
      if (btn) btn.textContent = '▶';
    }
  }

  toggleFavorite(voiceId) {
    const voice = this.voices.find(v => v.id === voiceId);
    if (!voice) return;

    const baseName = this.parseVoiceVersion(voice.title).baseName.toLowerCase();
    const newFavState = !voice.isFavorite;

    this.voices.forEach(v => {
      if (this.parseVoiceVersion(v.title).baseName.toLowerCase() === baseName) {
        v.isFavorite = newFavState;
      }
    });

    StorageManager.saveVoices(this.voices);
    this.autoSyncDiskFile();
    this.renderFolders();
    this.render();
  }

  startSmoothProgressLoop(id) {
    this.stopSmoothProgressLoop();

    const update = () => {
      if (this.currentPlayingId === id) {
        const audio = this.audioPlayers.get(id);
        const card = document.querySelector(`.voice-item[data-id="${CSS.escape(String(id))}"]`);

        if (audio && card && audio.duration && !audio.paused) {
          const seekBar = card.querySelector('.seek-bar');
          const curTimeEl = card.querySelector('.cur-time');

          const percent = (audio.currentTime / audio.duration) * 100;
          if (seekBar) {
            seekBar.value = percent;
            seekBar.style.background = `linear-gradient(to right, #ffffff ${percent}%, #262626 ${percent}%)`;
          }
          if (curTimeEl) {
            curTimeEl.textContent = this.formatTime(audio.currentTime);
          }
          this.animFrameId = requestAnimationFrame(update);
          return;
        }
      }
    };
    this.animFrameId = requestAnimationFrame(update);
  }

  stopSmoothProgressLoop() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  formatTime(sec) {
    if (isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  escape(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    })[m]);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
