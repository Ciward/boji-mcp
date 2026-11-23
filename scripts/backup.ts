import { DatabaseSync,backup } from 'node:sqlite';
import { mkdirSync,chmodSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { getConfig } from '../src/config.js';
const config=getConfig();const out=resolve(process.argv[2]??'backups');mkdirSync(out,{recursive:true,mode:0o700});
const db=new DatabaseSync(join(config.dataDir,'boji.sqlite'),{readOnly:true});const dest=join(out,`boji-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
try{await backup(db,dest);chmodSync(dest,0o600);console.log(`一致性备份完成：${dest}`);}finally{db.close();}
