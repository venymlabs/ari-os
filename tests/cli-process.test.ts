import {afterEach,describe,expect,it} from "vitest";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "../src/server.js";
const exec=promisify(execFile),dirs:string[]=[];
afterEach(async()=>Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true}))));
async function local(args:string[]){const d=await mkdtemp(join(tmpdir(),"raos-cli-"));dirs.push(d);return exec(process.execPath,[join(process.cwd(),"dist/bin/robinhood-agent-os.js"),...args],{env:{...process.env,DATA_DIR:d,NODE_ENV:"test"}})}
describe("standalone CLI process",()=>{
 it.each(["status","sessions","tools","skills","markets","jobs"])("runs %s locally",async command=>{const {stdout}=await local([command]);expect(JSON.parse(stdout)).toMatchObject({ok:true})});
 it("reports the actual unconfigured model error",async()=>{const e:any=await local(["chat","hello"]).catch(x=>x);expect(e.code).toBe(1);expect(JSON.parse(e.stdout)).toMatchObject({ok:false,error:"Model provider is not configured"})});
 it("calls command-specific remote endpoint with bearer auth",async()=>{let auth="";const app=createServer({ready:()=>true,health:async()=>({}),apiToken:"secret",resources:{sessions:async()=>[{id:"s"}]}});app.addHook("onRequest",async q=>{auth=String(q.headers.authorization??"")});await app.listen({host:"127.0.0.1",port:0});const address=app.server.address();const port=typeof address==="object"&&address?address.port:0;const {stdout}=await local(["--remote",`http://127.0.0.1:${port}`,"--token","secret","sessions"]);expect(JSON.parse(stdout).result).toEqual([{id:"s"}]);expect(auth).toBe("Bearer secret");await app.close()});
 it("package exposes Telegram executable and service",async()=>{const p=JSON.parse(await readFile("package.json","utf8"));expect(p.bin["raos-telegram"]).toBe("dist/bin/telegram.js");expect(p.scripts.telegram).toBe("node dist/bin/telegram.js");expect(await readFile("deploy/systemd/raos-telegram.service","utf8")).toContain("raos-telegram")});
});
