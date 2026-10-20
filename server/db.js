// Almacenamiento simple en un fichero JSON. Suficiente para un grupo de
// voluntarios (decenas o cientos de personas), sin base de datos externa.
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = { users: [], sessions: [], alerts: [], subscriptions: [] };

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let data = structuredClone(EMPTY);
  if (fs.existsSync(file)) {
    data = { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }

  function save() {
    // Escritura atómica: si el proceso muere a mitad, no se corrompe el fichero.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  return { data, save };
}
