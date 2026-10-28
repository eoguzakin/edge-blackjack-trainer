import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
// Only the local development server/test harness runs migrations. Production uses Sites migrations.
export function localDatabase(path=':memory:'){
  const sqlite=new DatabaseSync(path);sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
  for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort()){
    if(sqlite.prepare('SELECT name FROM local_migrations WHERE name=?').get(name))continue;
    sqlite.exec('BEGIN');try{sqlite.exec(readFileSync(new URL(`../drizzle/${name}`,import.meta.url),'utf8'));sqlite.prepare('INSERT INTO local_migrations (name) VALUES (?)').run(name);sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');throw e;}
  }
  const prepare=(sql,values=[])=>({sql,values,bind(...args){return prepare(sql,args);},async first(column){const row=sqlite.prepare(sql).get(...values);return column?row?.[column]??null:row??null;},async all(){return {results:sqlite.prepare(sql).all(...values)};},async run(){const result=sqlite.prepare(sql).run(...values);return {success:true,meta:{changes:Number(result.changes)}};}});
  return {sqlite,prepare,async batch(statements){
    sqlite.exec('BEGIN IMMEDIATE');
    try{const results=statements.map(s=>{const result=sqlite.prepare(s.sql).run(...s.values);return {success:true,meta:{changes:Number(result.changes)}};});sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}
  }};
}
