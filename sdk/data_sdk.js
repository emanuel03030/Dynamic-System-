// Data SDK - API remota com fallback local + fila de sincronizacao offline
window.dataSdk = {
  data: [],
  handler: null,
  mode: 'local',
  storageAvailable: true,
  storageKey: 'CollaboratorData::shared',
  pendingOpsKey: 'CollaboratorData::pendingOps',
  pendingOps: [],
  apiBaseUrl: '',
  apiReconnectIntervalMs: 5000,
  _eventSource: null,
  _apiRecoveryTimer: null,
  _apiRecoveryRunning: false,
  _queueSyncRunning: false,

  init: async function(handler) {
    this.handler = handler;
    this.storageAvailable = this.checkStorageAvailability();
    this.storageKey = this.getStorageKey();
    this.pendingOpsKey = this.getPendingOpsKey();
    this.apiBaseUrl = this.getApiBaseUrl();

    this.migrateLegacyStorageKeys();

    this.setupCrossTabSync();
    this.loadPendingOpsFromLocal();
    this.startApiRecoveryMonitor();

    const apiReady = await this.checkApiAvailability();
    if (apiReady) {
      this.mode = 'api';
      this.subscribeToEvents();

      const synced = await this.syncWithApi();
      if (synced.isOk) {
        this.notifyDataChanged();
        return { isOk: true, mode: this.mode, syncedPendingOps: synced.replayed || 0 };
      }

      console.warn('[DataSDK] Falha ao sincronizar com API. Usando localStorage.', synced.error && synced.error.message);
      this.mode = 'local';
    }

    if (!this.storageAvailable) {
      console.warn('[DataSDK] localStorage indisponivel. Dados nao serao persistidos.');
      this.data = [];
      this.notifyDataChanged();
      return { isOk: true, warning: 'Local storage unavailable', mode: this.mode };
    }

    const loaded = this.loadFromLocal();
    if (!loaded.isOk) {
      console.warn('[DataSDK] Falha ao carregar localStorage:', loaded.error && loaded.error.message);
    }

    this.notifyDataChanged();
    return { isOk: true, mode: this.mode };
  },

  create: async function(item) {
    const safeItem = { ...item, __backendId: item && item.__backendId ? item.__backendId : this.generateId() };

    if (this.mode === 'api') {
      const remote = await this.request('/api/records', {
        method: 'POST',
        body: JSON.stringify(safeItem)
      });

      if (remote.isOk) {
        this.data.push(remote.data || safeItem);
        this.notifyDataChanged();
        return { isOk: true, mode: this.mode };
      }

      if (this.shouldFallbackToOffline(remote)) {
        return this.applyOfflineCreate(safeItem, true, remote.error && remote.error.message);
      }

      return remote;
    }

    return this.applyOfflineCreate(safeItem, true);
  },

  update: async function(item) {
    const index = this.data.findIndex((d) => d.__backendId === item.__backendId);
    if (index === -1) {
      return { isOk: false, error: { message: 'Item not found' } };
    }

    const safeItem = { ...item };

    if (this.mode === 'api') {
      const remote = await this.request('/api/records/' + encodeURIComponent(safeItem.__backendId), {
        method: 'PUT',
        body: JSON.stringify(safeItem)
      });

      if (remote.isOk) {
        this.data[index] = remote.data || safeItem;
        this.notifyDataChanged();
        return { isOk: true, mode: this.mode };
      }

      if (this.shouldFallbackToOffline(remote)) {
        return this.applyOfflineUpdate(index, safeItem, true, remote.error && remote.error.message);
      }

      return remote;
    }

    return this.applyOfflineUpdate(index, safeItem, true);
  },

  delete: async function(item) {
    const index = this.data.findIndex((d) => d.__backendId === item.__backendId);
    if (index === -1) {
      return { isOk: false, error: { message: 'Item not found' } };
    }

    if (this.mode === 'api') {
      const remote = await this.request('/api/records/' + encodeURIComponent(item.__backendId), {
        method: 'DELETE'
      });

      if (remote.isOk) {
        this.data.splice(index, 1);
        this.notifyDataChanged();
        return { isOk: true, mode: this.mode };
      }

      if (this.shouldFallbackToOffline(remote)) {
        return this.applyOfflineDelete(index, item, true, remote.error && remote.error.message);
      }

      return remote;
    }

    return this.applyOfflineDelete(index, item, true);
  },

  applyOfflineCreate: function(item, queueForSync, reasonMessage) {
    this.mode = 'local';
    this.data.push(item);

    const saved = this.saveToLocal();
    if (!saved.isOk) {
      this.data.pop();
      return saved;
    }

    if (queueForSync) {
      this.enqueuePendingOp({ op: 'create', item: { ...item } });
    }

    this.notifyDataChanged();
    return {
      isOk: true,
      mode: this.mode,
      queued: !!queueForSync,
      warning: reasonMessage ? ('API indisponivel. Operacao enfileirada: ' + reasonMessage) : undefined
    };
  },

  applyOfflineUpdate: function(index, item, queueForSync, reasonMessage) {
    this.mode = 'local';
    const previous = this.data[index];
    this.data[index] = { ...item };

    const saved = this.saveToLocal();
    if (!saved.isOk) {
      this.data[index] = previous;
      return saved;
    }

    if (queueForSync) {
      this.enqueuePendingOp({ op: 'update', item: { ...item } });
    }

    this.notifyDataChanged();
    return {
      isOk: true,
      mode: this.mode,
      queued: !!queueForSync,
      warning: reasonMessage ? ('API indisponivel. Operacao enfileirada: ' + reasonMessage) : undefined
    };
  },

  applyOfflineDelete: function(index, item, queueForSync, reasonMessage) {
    this.mode = 'local';
    const removed = this.data[index];
    this.data.splice(index, 1);

    const saved = this.saveToLocal();
    if (!saved.isOk) {
      this.data.splice(index, 0, removed);
      return saved;
    }

    if (queueForSync) {
      this.enqueuePendingOp({ op: 'delete', item: { __backendId: item.__backendId } });
    }

    this.notifyDataChanged();
    return {
      isOk: true,
      mode: this.mode,
      queued: !!queueForSync,
      warning: reasonMessage ? ('API indisponivel. Operacao enfileirada: ' + reasonMessage) : undefined
    };
  },

  syncWithApi: async function() {
    if (this.mode !== 'api') {
      return { isOk: false, error: { message: 'API mode not active' } };
    }

    const replay = await this.flushPendingOps();
    if (!replay.isOk) {
      return replay;
    }

    const remoteLoad = await this.loadFromApi();
    if (!remoteLoad.isOk) {
      return remoteLoad;
    }

    return { isOk: true, replayed: replay.replayed || 0 };
  },

  flushPendingOps: async function() {
    if (this.mode !== 'api') {
      return { isOk: false, error: { message: 'API mode not active' } };
    }

    if (this._queueSyncRunning) {
      return { isOk: true, replayed: 0, skipped: true };
    }

    this._queueSyncRunning = true;
    let replayed = 0;

    try {
      while (this.pendingOps.length > 0) {
        const op = this.pendingOps[0];
        const result = await this.replayPendingOp(op);
        if (!result.isOk) {
          return result;
        }

        this.pendingOps.shift();
        this.savePendingOpsToLocal();
        replayed += 1;
      }

      return { isOk: true, replayed: replayed };
    } finally {
      this._queueSyncRunning = false;
    }
  },

  replayPendingOp: async function(op) {
    const opType = op && op.op;
    const item = (op && op.item) || {};
    const id = String(item.__backendId || '');

    if (!opType) {
      return { isOk: true };
    }

    if (opType === 'create') {
      const created = await this.request('/api/records', {
        method: 'POST',
        body: JSON.stringify(item)
      });

      if (created.isOk) {
        return { isOk: true };
      }

      // Registro ja existe no backend: converte para update.
      if (created.status === 409 || created.status === 400) {
        const updated = await this.request('/api/records/' + encodeURIComponent(id), {
          method: 'PUT',
          body: JSON.stringify(item)
        });
        return updated.isOk ? { isOk: true } : updated;
      }

      return created;
    }

    if (opType === 'update') {
      const updated = await this.request('/api/records/' + encodeURIComponent(id), {
        method: 'PUT',
        body: JSON.stringify(item)
      });

      if (updated.isOk) {
        return { isOk: true };
      }

      // Registro nao existe no backend: converte para create.
      if (updated.status === 404) {
        const created = await this.request('/api/records', {
          method: 'POST',
          body: JSON.stringify(item)
        });
        return created.isOk ? { isOk: true } : created;
      }

      return updated;
    }

    if (opType === 'delete') {
      const removed = await this.request('/api/records/' + encodeURIComponent(id), {
        method: 'DELETE'
      });

      // Se o registro nao existe mais, considera sincronizado.
      if (removed.isOk || removed.status === 404) {
        return { isOk: true };
      }

      return removed;
    }

    return { isOk: true };
  },

  enqueuePendingOp: function(op) {
    if (!op || !op.op) return;

    this.pendingOps.push({
      op: op.op,
      item: op.item || {},
      queuedAt: Date.now()
    });
    this.savePendingOpsToLocal();
  },

  loadPendingOpsFromLocal: function() {
    if (!this.storageAvailable) {
      this.pendingOps = [];
      return;
    }

    try {
      const stored = localStorage.getItem(this.pendingOpsKey);
      if (!stored) {
        this.pendingOps = [];
        return;
      }

      const parsed = JSON.parse(stored);
      this.pendingOps = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      this.pendingOps = [];
    }
  },

  savePendingOpsToLocal: function() {
    if (!this.storageAvailable) {
      return { isOk: false, error: { message: 'Local storage unavailable' } };
    }

    try {
      localStorage.setItem(this.pendingOpsKey, JSON.stringify(this.pendingOps));
      return { isOk: true };
    } catch (err) {
      return { isOk: false, error: { message: err && err.message ? err.message : 'Failed to persist pending operations' } };
    }
  },

  loadFromApi: async function() {
    const response = await this.request('/api/records', { method: 'GET' });
    if (!response.isOk) {
      return response;
    }

    this.data = Array.isArray(response.data) ? response.data : [];
    this.persistMirrorToLocal();
    return { isOk: true };
  },

  loadFromLocal: function() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (!stored) {
        this.data = [];
        return { isOk: true };
      }

      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) {
        return { isOk: false, error: { message: 'Stored payload is not an array' } };
      }

      this.data = parsed;
      return { isOk: true };
    } catch (err) {
      return { isOk: false, error: { message: err && err.message ? err.message : 'Invalid JSON in localStorage' } };
    }
  },

  save: function() {
    return this.saveToLocal();
  },

  saveToLocal: function() {
    if (!this.storageAvailable) {
      return { isOk: false, error: { message: 'Local storage unavailable' } };
    }

    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.data));
      return { isOk: true };
    } catch (err) {
      return { isOk: false, error: { message: err && err.message ? err.message : 'Failed to persist data' } };
    }
  },

  persistMirrorToLocal: function() {
    if (!this.storageAvailable) return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.data));
    } catch (err) {
      // ignorar falha de mirror
    }
  },

  notifyDataChanged: function() {
    this.persistMirrorToLocal();
    if (this.handler && this.handler.onDataChanged) {
      this.handler.onDataChanged(this.data);
    }
  },

  checkStorageAvailability: function() {
    try {
      const testKey = '__dataSdkTest__';
      localStorage.setItem(testKey, '1');
      localStorage.removeItem(testKey);
      return true;
    } catch (err) {
      return false;
    }
  },

  getStorageKey: function() {
    return 'CollaboratorData::shared';
  },

  getPendingOpsKey: function() {
    return 'CollaboratorData::pendingOps';
  },

  migrateLegacyStorageKeys: function() {
    if (!this.storageAvailable) return;
    try {
      const legacyStorageKey = 'employeeData::shared';
      const legacyPendingOpsKey = 'employeeData::pendingOps';

      if (!localStorage.getItem(this.storageKey)) {
        const legacyData = localStorage.getItem(legacyStorageKey);
        if (legacyData) {
          localStorage.setItem(this.storageKey, legacyData);
        }
      }

      if (!localStorage.getItem(this.pendingOpsKey)) {
        const legacyPendingOps = localStorage.getItem(legacyPendingOpsKey);
        if (legacyPendingOps) {
          localStorage.setItem(this.pendingOpsKey, legacyPendingOps);
        }
      }
    } catch (err) {
      // Ignora falhas de migracao para nao interromper a inicializacao.
    }
  },

  getApiBaseUrl: function() {
    if (window.__DATA_API_BASE_URL) {
      return String(window.__DATA_API_BASE_URL).replace(/\/$/, '');
    }
    return 'http://localhost:3001';
  },

  checkApiAvailability: async function() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(function() {
        controller.abort();
      }, 2000);

      const response = await fetch(this.apiBaseUrl + '/health', { method: 'GET', signal: controller.signal });
      clearTimeout(timeout);
      return response.ok;
    } catch (err) {
      return false;
    }
  },

  startApiRecoveryMonitor: function() {
    if (this._apiRecoveryTimer) return;
    var self = this;
    this._apiRecoveryTimer = setInterval(function() {
      self.tryRecoverApiMode();
    }, this.apiReconnectIntervalMs);
  },

  tryRecoverApiMode: async function() {
    if (this.mode === 'api' || this._apiRecoveryRunning) {
      return;
    }

    this._apiRecoveryRunning = true;
    try {
      const apiReady = await this.checkApiAvailability();
      if (!apiReady) {
        return;
      }

      this.mode = 'api';
      this.subscribeToEvents();
      const synced = await this.syncWithApi();
      if (!synced.isOk) {
        this.mode = 'local';
        return;
      }

      this.notifyDataChanged();
    } finally {
      this._apiRecoveryRunning = false;
    }
  },

  shouldFallbackToOffline: function(requestResult) {
    if (!requestResult || requestResult.isOk) {
      return false;
    }

    // Falha de rede/servidor deve cair para modo offline automaticamente.
    return requestResult.status === 0 || requestResult.status >= 500;
  },

  request: async function(path, options) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (options && options.headers) {
        Object.assign(headers, options.headers);
      }

      // Anexa o token de sessão (JWT) em toda requisição, para o backend saber
      // quem está chamando e bloquear quem não estiver logado.
      try {
        const authToken = sessionStorage.getItem('authToken');
        if (authToken) {
          headers['Authorization'] = 'Bearer ' + authToken;
        }
      } catch (_) { /* sessionStorage indisponível */ }

      const response = await fetch(this.apiBaseUrl + path, {
        ...options,
        headers: headers
      });

      const text = await response.text();
      let payload = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (err) {
          payload = {};
        }
      }

      if (response.status === 401) {
        // Sessão expirada/inválida: limpa e manda para o login novamente.
        try {
          sessionStorage.removeItem('loggedUser');
          sessionStorage.removeItem('authToken');
        } catch (_) { /* ignore */ }
        if (typeof window !== 'undefined' && window.location && !/login\.html/i.test(window.location.pathname)) {
          window.location.replace('login.html?motivo=expirada');
        }
        return {
          isOk: false,
          status: 401,
          error: { message: (payload.error && payload.error.message) || 'Sessão expirada. Faça login novamente.' }
        };
      }

      if (!response.ok || payload.isOk === false) {
        return {
          isOk: false,
          status: response.status,
          error: {
            message: (payload.error && payload.error.message) || ('Request failed with status ' + response.status)
          }
        };
      }

      return { isOk: true, status: response.status, data: payload.data };
    } catch (err) {
      return {
        isOk: false,
        status: 0,
        error: { message: err && err.message ? err.message : 'Network error' }
      };
    }
  },

  generateId: function() {
    return Date.now().toString() + Math.random().toString(36).slice(2, 11);
  },

  // Sincronizacao em tempo real via Server-Sent Events
  subscribeToEvents: function() {
    if (typeof EventSource === 'undefined') return;
    if (this._eventSource) {
      this._eventSource.close();
      this._eventSource = null;
    }

    var self = this;
    var es = new EventSource(this.apiBaseUrl + '/api/events');

    es.onmessage = function(e) {
      try {
        var event = JSON.parse(e.data);
        if (event.type === 'dataChanged') {
          self.loadFromApi().then(function(result) {
            if (result.isOk) {
              self.notifyDataChanged();
            }
          });
        }
      } catch (err) {
        // ignora payload invalido
      }
    };

    es.onerror = function() {
      es.close();
      self._eventSource = null;
      setTimeout(function() {
        if (self.mode === 'api') {
          self.subscribeToEvents();
        }
      }, 5000);
    };

    this._eventSource = es;
  },

  // Sincronizacao entre multiplas abas
  setupCrossTabSync: function() {
    var self = this;
    window.addEventListener('storage', function(e) {
      if (e.key === self.storageKey && e.newValue !== e.oldValue) {
        try {
          var newData = JSON.parse(e.newValue);
          if (Array.isArray(newData)) {
            self.data = newData;
            self.notifyDataChanged();
          }
        } catch (err) {
          // dados invalidos, ignorar
        }
      }

      if (e.key === self.pendingOpsKey && e.newValue !== e.oldValue) {
        self.loadPendingOpsFromLocal();
      }
    });
  }
};