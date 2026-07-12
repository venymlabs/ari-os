import { createHash } from "node:crypto";

interface Entry { index:number; type:string; payload:unknown; previousHash:string; hash:string }
const canonical=(value:unknown):string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
};
const digest=(entry:Omit<Entry,"hash">)=>createHash("sha256").update(canonical(entry)).digest("hex");

export class AuditJournal {
  readonly #entries: Entry[]=[];
  append(type:string,payload:unknown):Readonly<Entry>{
    const base={index:this.#entries.length,type,payload,previousHash:this.#entries.at(-1)?.hash ?? "GENESIS"};
    const entry={...base,hash:digest(base)}; this.#entries.push(entry); return entry;
  }
  verify():boolean{return this.#entries.every((e,i)=>e.index===i && e.previousHash===(this.#entries[i-1]?.hash ?? "GENESIS") && e.hash===digest({index:e.index,type:e.type,payload:e.payload,previousHash:e.previousHash}));}
  unsafeEntriesForTest():Entry[]{return this.#entries;}
}
