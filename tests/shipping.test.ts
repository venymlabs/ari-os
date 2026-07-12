import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execFileAsync=promisify(execFile);
import {createServer} from "../src/server.js";
import {resolveInputArgument} from "../src/bin/robinhood-agent-os.js";
import {TelegramRunner,type TelegramOffsetStore} from "../src/telegram/runner.js";

const dirs:string[]=[];
afterEach(async()=>Promise.all(dirs.splice(0).map(x=>rm(x,{recursive:true,force:true}))));

describe("server",()=>{
 it("exposes lifecycle, metrics, build metadata and dynamic signing status without authentication",async()=>{const app=createServer({ready:()=>true,health:async()=>({runtime:{status:"ok"}}),version:"1.2.3",build:"abc",signing:true});await app.ready();expect((await app.inject("/livez")).statusCode).toBe(200);expect((await app.inject("/readyz")).statusCode).toBe(200);expect((await app.inject("/metrics")).body).toContain("raos_ready 1");expect((await app.inject("/version")).json()).toMatchObject({version:"1.2.3",build:"abc",signing:true});expect((await app.inject("/v1/health")).json()).toMatchObject({signing:true});await app.close()});
 it("returns 503 while dependencies are not ready",async()=>{const app=createServer({ready:()=>false,health:async()=>({db:{status:"down"}})});await app.ready();expect((await app.inject("/readyz")).statusCode).toBe(503);await app.close()});
});

describe("CLI input",()=>{it("loads @file JSON",async()=>{const d=await mkdtemp(join(tmpdir(),"raos-"));dirs.push(d);const p=join(d,"in.json");await writeFile(p,'{"amount":1}');expect(await resolveInputArgument(`@${p}`)).toEqual({amount:1})});it("loads stdin represented by dash",async()=>expect(await resolveInputArgument("-",async()=>'{"amount":2}')).toEqual({amount:2}))});

describe("package shipping contract",()=>{
 it("publishes the real CLI and server entrypoints",async()=>{const pkg=JSON.parse(await readFile(join(process.cwd(),"package.json"),"utf8"));expect(pkg).toMatchObject({name:"robinhood-agent-os",version:"0.1.0",license:"MIT",private:false,bin:{raos:"dist/bin/robinhood-agent-os.js"},files:expect.arrayContaining(["dist","README.md","LICENSE"])});expect(pkg.scripts.start).toBe("node dist/server.js");expect(pkg.scripts.dev).toContain("dist/server.js");expect(pkg.scripts.cli).toBe("node dist/bin/robinhood-agent-os.js")});
 it("builds a packable executable CLI with matching version",async()=>{const pkg=JSON.parse(await readFile(join(process.cwd(),"package.json"),"utf8"));const cli=await readFile(join(process.cwd(),pkg.bin.raos),"utf8");expect(cli.startsWith("#!/usr/bin/env node")).toBe(true);const {stdout}=await execFileAsync(process.execPath,[join(process.cwd(),pkg.bin.raos),"--version"]);expect(stdout.trim()).toBe(pkg.version);const packed=JSON.parse((await execFileAsync("npm",["pack","--dry-run","--json"])).stdout)[0];expect(packed.files.map((x:{path:string})=>x.path)).toEqual(expect.arrayContaining(["dist/server.js","dist/bin/robinhood-agent-os.js","README.md","LICENSE"]));
 },30000);
 it("ships a usable signer CLI and only the canonical signer unit",async()=>{const pkg=JSON.parse(await readFile(join(process.cwd(),"package.json"),"utf8"));expect(pkg.bin["raos-signer"]).toBe("dist/bin/signer.js");const signer=join(process.cwd(),pkg.bin["raos-signer"]);const version=await execFileAsync(process.execPath,[signer,"--version"]);expect(version.stdout.trim()).toBe(pkg.version);const help=await execFileAsync(process.execPath,[signer,"--help"]);expect(help.stdout).toContain("raos-signer");for(const option of ["--rpc","--key-id","--policy"])expect(help.stdout).toContain(option);const packed=JSON.parse((await execFileAsync("npm",["pack","--dry-run","--json","--ignore-scripts"])).stdout)[0];const paths=packed.files.map((x:{path:string})=>x.path);expect(paths).toContain("deploy/systemd/raos-signer.service");expect(paths).not.toContain("deploy/raos-signer.service");
 },30000);
});

describe("Telegram runner",()=>{it("persists offset before dispatch so restart cannot replay",async()=>{let offset=0;const store:TelegramOffsetStore={load:async()=>offset,save:async x=>{offset=x}};const fetch=vi.fn(async()=>({ok:true,json:async()=>({ok:true,result:[{update_id:4,message:{message_id:1,date:1,text:"hi",chat:{id:2},from:{id:3}}}]})}));const dispatch=vi.fn();const runner=new TelegramRunner({token:"x",store,fetch,allowedUserIds:new Set(["3"]),dispatch});await runner.pollOnce();expect(offset).toBe(5);expect(dispatch).toHaveBeenCalledOnce();const runner2=new TelegramRunner({token:"x",store,fetch,allowedUserIds:new Set(["3"]),dispatch});await runner2.pollOnce();expect(dispatch).toHaveBeenCalledOnce()});
 it("defaults to denying all actors and checks getMe readiness",async()=>{const store:TelegramOffsetStore={load:async()=>0,save:async()=>{}};const fetch=vi.fn(async(url:string)=>({ok:true,json:async()=>url.endsWith("getMe")?{ok:true,result:{id:1}}:{ok:true,result:[{update_id:1,message:{message_id:1,date:1,text:"hi",chat:{id:2},from:{id:3}}}]}}));const dispatch=vi.fn();const runner=new TelegramRunner({token:"x",store,fetch,dispatch});expect(await runner.check()).toBe(true);await runner.pollOnce();expect(dispatch).not.toHaveBeenCalled()})});
