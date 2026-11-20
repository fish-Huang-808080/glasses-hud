const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/PC/.zcode/cli/db/db.sqlite', { readOnly: true });
console.log('活跃会话:');
for (const r of db.prepare('SELECT s.id, s.title, s.directory FROM session s JOIN session_runtime_presence p ON p.session_id=s.id GROUP BY s.id').all()) {
  const dir = String(r.directory || '');
  const last = dir.split(/[\\/]/).pop();
  console.log(' -', r.title, '| dir:', last);
}
db.close();
