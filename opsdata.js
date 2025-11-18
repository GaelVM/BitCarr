/*! opsdata.js - Data layer (IndexedDB + localStorage + Vercel Blob remoto opcional) */
(function (global) {
  const DB_NAME = "opsdriver";
  const DB_VERSION = 1;
  const STORES = ["users", "vehicles", "requests", "movements"];
  let db = null;

  // Abrir / crear IndexedDB
  function openDB() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        STORES.forEach((name) => {
          if (!d.objectStoreNames.contains(name)) {
            const store = d.createObjectStore(name, {
              keyPath: "id",
              autoIncrement: true,
            });
            store.createIndex("createdAt", "createdAt", { unique: false });
            if (name === "users") {
              store.createIndex("role", "role", { unique: false });
            }
            if (name === "requests") {
              store.createIndex("estado", "estado", { unique: false });
              store.createIndex("papeleta", "papeleta", { unique: true });
            }
            if (name === "movements") {
              store.createIndex("tipo", "tipo", { unique: false });
            }
          }
        });
      };

      req.onsuccess = () => {
        db = req.result;
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Helper de transacciones
  function tx(store, mode = "readonly") {
    return openDB().then((d) => d.transaction(store, mode).objectStore(store));
  }

  // Obtener todos los registros de un store
  function getAll(store) {
    return tx(store)
      .then(
        (os) =>
          new Promise((resolve, reject) => {
            const out = [];
            const req = os.openCursor();
            req.onsuccess = (e) => {
              const cur = e.target.result;
              if (cur) {
                out.push(cur.value);
                cur.continue();
              } else {
                resolve(out);
              }
            };
            req.onerror = () => reject(req.error);
          })
      )
      .catch(() => {
        // Fallback localStorage
        const raw = localStorage.getItem("ops_" + store);
        return raw ? JSON.parse(raw) : [];
      });
  }

  // Insertar / actualizar (put)
  function put(store, value) {
    value.createdAt = value.createdAt || new Date().toISOString();
    return tx(store, "readwrite")
      .then(
        (os) =>
          new Promise((resolve, reject) => {
            const req = os.put(value);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          })
      )
      .catch(() => {
        // Fallback localStorage
        const list = JSON.parse(
          localStorage.getItem("ops_" + store) || "[]"
        );
        value.id =
          value.id ||
          (list.length ? Math.max(...list.map((x) => x.id || 0)) + 1 : 1);
        list.push(value);
        localStorage.setItem("ops_" + store, JSON.stringify(list));
        return value.id;
      });
  }

  // Actualizar parcialmente
  function update(store, id, patch) {
    return getAll(store).then((list) => {
      const item = list.find((x) => x.id === id);
      if (!item) return false;
      Object.assign(item, patch, { updatedAt: new Date().toISOString() });

      return tx(store, "readwrite")
        .then(
          (os) =>
            new Promise((resolve, reject) => {
              const req = os.put(item);
              req.onsuccess = () => resolve(true);
              req.onerror = () => reject(req.error);
            })
        )
        .catch(() => {
          // Fallback localStorage
          localStorage.setItem("ops_" + store, JSON.stringify(list));
          return true;
        });
    });
  }

  // Eliminar un registro
  function remove(store, id) {
    return getAll(store).then((list) => {
      const idx = list.findIndex((x) => x.id === id);
      if (idx < 0) return false;

      return tx(store, "readwrite")
        .then(
          (os) =>
            new Promise((resolve, reject) => {
              const req = os.delete(id);
              req.onsuccess = () => resolve(true);
              req.onerror = () => reject(req.error);
            })
        )
        .catch(() => {
          // Fallback localStorage
          list.splice(idx, 1);
          localStorage.setItem("ops_" + store, JSON.stringify(list));
          return true;
        });
    });
  }

  // Limpiar un store
  function clearStore(store) {
    return tx(store, "readwrite")
      .then(
        (os) =>
          new Promise((resolve, reject) => {
            const req = os.clear();
            req.onsuccess = () => resolve(true);
            req.onerror = () => reject(req.error);
          })
      )
      .catch(() => {
        localStorage.removeItem("ops_" + store);
        return true;
      });
  }

  // Exportar todo como objeto { users:[], vehicles:[], ... }
  function exportAll() {
    return Promise.all(
      STORES.map((s) => getAll(s).then((items) => [s, items]))
    ).then((entries) => Object.fromEntries(entries));
  }

  // Importar todo desde JSON / objeto
  function importAll(data) {
    const obj = typeof data === "string" ? JSON.parse(data) : data;
    return Promise.all(STORES.map((s) => clearStore(s))).then(async () => {
      for (const s of STORES) {
        const arr = obj[s] || [];
        for (const item of arr) {
          await put(s, item);
        }
      }
      return true;
    });
  }

  // Generar número de papeleta simple
  function genPapeleta() {
    const y = new Date().getFullYear();
    const rnd = Math.floor(Math.random() * 90000) + 10000;
    return String(rnd).padStart(5, "0") + "-" + y;
  }

  // --- Adaptador remoto (Vercel Blob via /api/store) ---

  // Puedes sobreescribir window.__OPS_REMOTE_BASE__ si quieres otro path
  const REMOTE_BASE =
    (typeof window !== "undefined" && window.__OPS_REMOTE_BASE__) ||
    "/api/store";

  async function remoteList(col) {
    const url = `${REMOTE_BASE}/${col}`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error("Remote GET failed");
      return await r.json();
    } catch (_) {
      return null; // null => remoto no disponible
    }
  }

  async function remotePost(col, body) {
    const url = `${REMOTE_BASE}/${col}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      throw new Error("Remote POST failed");
    }
  }

  // wrappers que intentan remoto y si falla usan local
  async function listWrapper(col, localFn, ...args) {
    const r = REMOTE_BASE ? await remoteList(col) : null;
    if (Array.isArray(r)) return r;
    return localFn(...args);
  }

  async function addWrapper(col, payload, localPutFn) {
    if (REMOTE_BASE) {
      try {
        await remotePost(col, { op: "add", payload });
        return true;
      } catch (_) {}
    }
    // fallback local
    return localPutFn(payload);
  }

  async function updateWrapper(col, id, patch, localUpdateFn) {
    if (REMOTE_BASE) {
      try {
        await remotePost(col, { op: "update", id, payload: patch });
        return true;
      } catch (_) {}
    }
    // fallback local
    return localUpdateFn(id, patch);
  }

  async function deleteWrapper(col, id, localRemoveFn) {
    if (REMOTE_BASE) {
      try {
        await remotePost(col, { op: "delete", id });
        return true;
      } catch (_) {}
    }
    // fallback local
    return localRemoveFn(id);
  }

  // --- API de dominio ---

  const API = {
    // base genérico
    getAll,
    put,
    update,
    remove,
    clearStore,
    exportAll,
    importAll,

    // usuarios (conductores, vigilantes, jefes, etc.)
    addUser: (u) =>
      addWrapper("users", u, (payload) => put("users", payload)),
    listUsers: (role) =>
      listWrapper("users", () => getAll("users")).then((xs) =>
        role ? xs.filter((x) => x.role === role) : xs
      ),
    deleteUser: (id) => deleteWrapper("users", id, (i) => remove("users", i)),

    // vehículos
    addVehicle: (v) =>
      addWrapper("vehicles", v, (payload) => put("vehicles", payload)),
    listVehicles: () => listWrapper("vehicles", () => getAll("vehicles")),
    deleteVehicle: (id) =>
      deleteWrapper("vehicles", id, (i) => remove("vehicles", i)),

    // solicitudes / papeletas
    createRequest: (r) =>
      addWrapper(
        "requests",
        Object.assign({ estado: "Pendiente", papeleta: genPapeleta() }, r),
        (payload) => put("requests", payload)
      ),
    listRequests: (estado) =>
      listWrapper("requests", () => getAll("requests")).then((xs) =>
        estado ? xs.filter((x) => x.estado === estado) : xs
      ),
    deleteRequest: (id) =>
      deleteWrapper("requests", id, (i) => remove("requests", i)),
    approveRequest: (id) =>
      updateWrapper(
        "requests",
        id,
        { estado: "Aprobado" },
        (i, p) => update("requests", i, p)
      ),
    rejectRequest: (id, obs) =>
      updateWrapper(
        "requests",
        id,
        { estado: "Rechazado", observacion: obs || "" },
        (i, p) => update("requests", i, p)
      ),

    // movimientos (registro de puerta, kms, etc.)
    addMovement: (m) =>
      addWrapper("movements", m, (payload) => put("movements", payload)),
    listMovements: (tipo) =>
      listWrapper("movements", () => getAll("movements")).then((xs) =>
        tipo ? xs.filter((x) => x.tipo === tipo) : xs
      ),
    deleteMovement: (id) =>
      deleteWrapper("movements", id, (i) => remove("movements", i)),
  };

  global.OpsData = API;
})(window);
