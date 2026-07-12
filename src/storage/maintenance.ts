import {DatabaseSync} from "node:sqlite";
export interface DatabaseStatus{path:string;exists:boolean;integrity:string;journalMode:string;tables:number}
const inspect=(path:string,create:boolean):DatabaseStatus=>{const db=new DatabaseSync(path);try{db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");const integrity=String((db.prepare("PRAGMA integrity_check").get() as any).integrity_check);const journalMode=create?String((db.prepare("PRAGMA journal_mode=WAL").get() as any).journal_mode):String((db.prepare("PRAGMA journal_mode").get() as any).journal_mode);const tables=Number((db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as any).n);return {path,exists:true,integrity,journalMode,tables}}finally{db.close()}};
export function checkDatabases(paths:string[]):DatabaseStatus[]{return paths.map(path=>inspect(path,false))}
export function migrateDatabases(paths:string[]):DatabaseStatus[]{return paths.map(path=>inspect(path,true))}
export function databaseStatus(paths:string[]):DatabaseStatus[]{return paths.map(path=>inspect(path,false))}
