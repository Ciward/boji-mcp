import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
export interface Config {host:string;port:number;publicUrl:string;publicUrlAliases?:string[];dataDir:string;timezone:string;adminPassword:string;webDir:string;}
/** Explicit deployment origins only; never infer trusted aliases from forwarded headers or stored grants. */
export function publicOrigins(publicUrl:string,aliases:readonly string[]=[]):string[] {
  const parse=(value:string)=>{
    let u:URL;try{u=new URL(value);}catch{throw new Error('BOJI_PUBLIC_URL must be an absolute HTTP(S) origin');}
    const loopback=u.hostname==='localhost'||u.hostname==='[::1]'||/^127(?:\.\d{1,3}){3}$/.test(u.hostname);
    if(!/^https?:\/\//.test(value)||/[\s\\*?#]/.test(value)||u.pathname!=='/'||u.search||u.hash||u.username||u.password||
      (u.protocol!=='https:'&&!(u.protocol==='http:'&&loopback)))throw new Error('BOJI_PUBLIC_URL aliases must be HTTPS origins (loopback HTTP is allowed), without paths or credentials');
    return u;
  };
  const primary=parse(publicUrl),origins=[primary.origin];
  for(const value of aliases){const u=parse(value);if(u.protocol!==primary.protocol)throw new Error('BOJI_PUBLIC_URL aliases must use the same protocol');origins.push(u.origin);}
  return [...new Set(origins)];
}
export function getConfig():Config {
  if(existsSync('.env'))loadEnvFile('.env');
  const port=Number(process.env.BOJI_PORT??8787),host=process.env.BOJI_HOST??'127.0.0.1';
  const publicUrl=(process.env.BOJI_PUBLIC_URL??`http://127.0.0.1:${port}`).replace(/\/$/,'');
  const aliases=(process.env.BOJI_PUBLIC_URL_ALIASES??'').split(',').map(value=>value.trim()).filter(Boolean);
  const [canonical,...publicUrlAliases]=publicOrigins(publicUrl,aliases);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('BOJI_PORT 无效');
  const adminPassword=process.env.BOJI_ADMIN_PASSWORD??'';if(adminPassword.length<24)throw new Error('先运行 npm run setup 生成不少于24字符的管理密码');
  const timezone=process.env.BOJI_TIMEZONE??'Asia/Shanghai';new Intl.DateTimeFormat('en',{timeZone:timezone});
  return {host,port,publicUrl:canonical!,publicUrlAliases,dataDir:resolve(process.env.BOJI_DATA_DIR??'./data'),timezone,adminPassword,webDir:resolve('dist/web')};
}
