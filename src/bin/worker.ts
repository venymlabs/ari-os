#!/usr/bin/env node
import {z} from "zod";
import {loadConfig} from "../config/index.js";
import {JobQueue} from "../autonomy/jobs/index.js";
import {JobHandlerRegistry,JobWorker} from "../workers/jobs.js";

export async function main(argv=process.argv.slice(2)){
 if(!argv.includes("--once"))throw new Error("worker currently requires --once");
 const config=loadConfig(process.env),queue=new JobQueue(config.paths.jobs),registry=new JobHandlerRegistry();
 // The operational worker owns the durable loop. Deployments register domain handlers here.
 queue.register("noop",z.unknown());registry.register("noop",z.unknown(),async()=>{});
 try{const processed=await new JobWorker(queue,registry,{workerId:process.env.WORKER_ID??`worker-${process.pid}`,leaseMs:30_000}).runOnce();console.log(JSON.stringify({worker:{once:true,processed}}))}finally{queue.close()}
}
main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1});
