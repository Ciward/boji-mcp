import { createApp } from './app.js';
import { getConfig } from './config.js';
const config=getConfig();const {app,store}=createApp(config);const server=app.listen(config.port,config.host,()=>console.log(`Boji listening at ${config.publicUrl} (MCP: /mcp)`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{server.close(()=>{store.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();});
